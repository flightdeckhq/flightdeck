package handlers

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"

	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// OTLP request size limits. maxOTLPCompressedBytes is the body as sent:
// four times the 1 MiB /v1/events cap, since one export batches many
// records (512 per request by default in the OpenTelemetry SDKs), each
// possibly carrying prompt text, while still bounding what one request
// makes the receiver buffer. maxOTLPDecompressedBytes bounds the body
// after gzip: OTLP payloads compress several times over, so a 4 MiB
// gzip body may legitimately inflate past 4 MiB, and 16 MiB stops a
// decompression bomb long before it exhausts memory. The edge proxy
// must allow maxOTLPCompressedBytes on /ingest/.
const (
	maxOTLPCompressedBytes   = 4 << 20
	maxOTLPDecompressedBytes = 16 << 20
)

// OTLP/HTTP media types.
const (
	otlpMediaProtobuf = "application/x-protobuf"
	otlpMediaJSON     = "application/json"
)

// gRPC status codes carried in the google.rpc.Status body of an OTLP
// error response (google.golang.org/grpc/codes; the values are fixed
// by the gRPC protocol).
const (
	grpcCodeInvalidArgument   int32 = 3
	grpcCodeResourceExhausted int32 = 8
	grpcCodeInternal          int32 = 13
	grpcCodeUnavailable       int32 = 14
	grpcCodeUnauthenticated   int32 = 16
)

// otlpEncoding is the encoding of an OTLP request, which its response
// is written in.
type otlpEncoding int

const (
	otlpEncodingJSON otlpEncoding = iota
	otlpEncodingProtobuf
)

// otlpSignal binds one OTLP signal's request and response messages to
// the receiver.
type otlpSignal struct {
	name       string
	newRequest func() proto.Message
	mapRequest func(ctx context.Context, d OTLPDialect, req proto.Message) OTLPMapping
	response   func(m OTLPMapping) proto.Message
}

var otlpLogsSignal = otlpSignal{
	name:       "logs",
	newRequest: func() proto.Message { return &collogs.ExportLogsServiceRequest{} },
	mapRequest: func(ctx context.Context, d OTLPDialect, req proto.Message) OTLPMapping {
		return d.MapLogs(ctx, req.(*collogs.ExportLogsServiceRequest))
	},
	response: func(m OTLPMapping) proto.Message {
		resp := &collogs.ExportLogsServiceResponse{}
		if m.Rejected > 0 || m.Message != "" {
			resp.PartialSuccess = &collogs.ExportLogsPartialSuccess{
				RejectedLogRecords: m.Rejected,
				ErrorMessage:       m.Message,
			}
		}
		return resp
	},
}

var otlpTracesSignal = otlpSignal{
	name:       "traces",
	newRequest: func() proto.Message { return &coltrace.ExportTraceServiceRequest{} },
	mapRequest: func(ctx context.Context, d OTLPDialect, req proto.Message) OTLPMapping {
		return d.MapTraces(ctx, req.(*coltrace.ExportTraceServiceRequest))
	},
	response: func(m OTLPMapping) proto.Message {
		resp := &coltrace.ExportTraceServiceResponse{}
		if m.Rejected > 0 || m.Message != "" {
			resp.PartialSuccess = &coltrace.ExportTracePartialSuccess{
				RejectedSpans: m.Rejected,
				ErrorMessage:  m.Message,
			}
		}
		return resp
	},
}

var otlpMetricsSignal = otlpSignal{
	name:       "metrics",
	newRequest: func() proto.Message { return &colmetrics.ExportMetricsServiceRequest{} },
	mapRequest: func(ctx context.Context, d OTLPDialect, req proto.Message) OTLPMapping {
		return d.MapMetrics(ctx, req.(*colmetrics.ExportMetricsServiceRequest))
	},
	response: func(m OTLPMapping) proto.Message {
		resp := &colmetrics.ExportMetricsServiceResponse{}
		if m.Rejected > 0 || m.Message != "" {
			resp.PartialSuccess = &colmetrics.ExportMetricsPartialSuccess{
				RejectedDataPoints: m.Rejected,
				ErrorMessage:       m.Message,
			}
		}
		return resp
	},
}

// OTLPStatus is the body of an OTLP error response: a google.rpc.Status
// in the request's encoding (protobuf, or JSON for a JSON request and
// for one whose media type is not supported).
type OTLPStatus struct {
	Code    int32  `json:"code"`
	Message string `json:"message"`
}

// OTLPExportLogsResponse documents the JSON form of the OTLP
// ExportLogsServiceResponse. partialSuccess is absent when every record
// was used.
type OTLPExportLogsResponse struct {
	PartialSuccess *OTLPLogsPartialSuccess `json:"partialSuccess,omitempty"`
}

// OTLPLogsPartialSuccess counts the log records Flightdeck did not use.
// rejectedLogRecords is an int64, written as a string in JSON.
type OTLPLogsPartialSuccess struct {
	RejectedLogRecords string `json:"rejectedLogRecords,omitempty" example:"3"`
	ErrorMessage       string `json:"errorMessage,omitempty"`
}

// OTLPExportTraceResponse documents the JSON form of the OTLP
// ExportTraceServiceResponse. partialSuccess is absent when every span
// was used.
type OTLPExportTraceResponse struct {
	PartialSuccess *OTLPTracePartialSuccess `json:"partialSuccess,omitempty"`
}

// OTLPTracePartialSuccess counts the spans Flightdeck did not use.
// rejectedSpans is an int64, written as a string in JSON.
type OTLPTracePartialSuccess struct {
	RejectedSpans string `json:"rejectedSpans,omitempty" example:"2"`
	ErrorMessage  string `json:"errorMessage,omitempty"`
}

// OTLPExportMetricsResponse documents the JSON form of the OTLP
// ExportMetricsServiceResponse. partialSuccess is absent when every
// data point was used.
type OTLPExportMetricsResponse struct {
	PartialSuccess *OTLPMetricsPartialSuccess `json:"partialSuccess,omitempty"`
}

// OTLPMetricsPartialSuccess counts the data points Flightdeck did not
// use. rejectedDataPoints is an int64, written as a string in JSON.
type OTLPMetricsPartialSuccess struct {
	RejectedDataPoints string `json:"rejectedDataPoints,omitempty" example:"8"`
	ErrorMessage       string `json:"errorMessage,omitempty"`
}

// OTLPLogsHandler handles POST /v1/logs.
//
// @Summary      Export OTLP logs
// @Description  OTLP/HTTP logs receiver. Accepts an ExportLogsServiceRequest as protobuf (application/x-protobuf) or OTLP JSON (application/json), optionally gzip-compressed (Content-Encoding: gzip). Answers 200 with an ExportLogsServiceResponse in the request's encoding whenever the body decodes; partialSuccess counts the log records Flightdeck did not map, with a message naming why. Error responses carry a google.rpc.Status in the request's encoding. The request is refused with 429 before it is read when the token's per-minute budget is spent, and is charged one unit per event it publishes.
// @Tags         otlp
// @Accept       json,application/x-protobuf
// @Produce      json,application/x-protobuf
// @Param        Authorization     header    string  true   "Bearer token"
// @Param        Content-Encoding  header    string  false  "gzip, or absent for an uncompressed body"
// @Param        request           body      object  true   "OTLP ExportLogsServiceRequest"
// @Success      200  {object}  OTLPExportLogsResponse
// @Failure      400  {object}  OTLPStatus  "body does not decode"
// @Failure      401  {object}  OTLPStatus  "missing or invalid bearer token"
// @Failure      413  {object}  OTLPStatus  "body over 4 MiB, or over 16 MiB decompressed"
// @Failure      415  {object}  OTLPStatus  "media type or content encoding not supported"
// @Failure      429  {object}  OTLPStatus  "rate limit exceeded; see Retry-After"
// @Failure      500  {object}  OTLPStatus  "token validation failed"
// @Header       429  {integer}  Retry-After  "seconds until the token's minute budget has room"
// @Failure      503  {object}  OTLPStatus  "publishing the mapped events failed; retry"
// @Router       /v1/logs [post]
func OTLPLogsHandler(validator TokenValidator, publisher EventPublisher, dialect OTLPDialect, limiter *RateLimiter) http.HandlerFunc {
	return otlpHandler(otlpLogsSignal, validator, publisher, dialect, limiter)
}

// OTLPTracesHandler handles POST /v1/traces.
//
// @Summary      Export OTLP traces
// @Description  OTLP/HTTP traces receiver. Accepts an ExportTraceServiceRequest as protobuf (application/x-protobuf) or OTLP JSON (application/json), optionally gzip-compressed (Content-Encoding: gzip). Answers 200 with an ExportTraceServiceResponse in the request's encoding whenever the body decodes; partialSuccess counts the spans Flightdeck did not map, with a message naming why. Error responses carry a google.rpc.Status in the request's encoding. The request is refused with 429 before it is read when the token's per-minute budget is spent, and is charged one unit per event it publishes.
// @Tags         otlp
// @Accept       json,application/x-protobuf
// @Produce      json,application/x-protobuf
// @Param        Authorization     header    string  true   "Bearer token"
// @Param        Content-Encoding  header    string  false  "gzip, or absent for an uncompressed body"
// @Param        request           body      object  true   "OTLP ExportTraceServiceRequest"
// @Success      200  {object}  OTLPExportTraceResponse
// @Failure      400  {object}  OTLPStatus  "body does not decode"
// @Failure      401  {object}  OTLPStatus  "missing or invalid bearer token"
// @Failure      413  {object}  OTLPStatus  "body over 4 MiB, or over 16 MiB decompressed"
// @Failure      415  {object}  OTLPStatus  "media type or content encoding not supported"
// @Failure      429  {object}  OTLPStatus  "rate limit exceeded; see Retry-After"
// @Failure      500  {object}  OTLPStatus  "token validation failed"
// @Header       429  {integer}  Retry-After  "seconds until the token's minute budget has room"
// @Failure      503  {object}  OTLPStatus  "publishing the mapped events failed; retry"
// @Router       /v1/traces [post]
func OTLPTracesHandler(validator TokenValidator, publisher EventPublisher, dialect OTLPDialect, limiter *RateLimiter) http.HandlerFunc {
	return otlpHandler(otlpTracesSignal, validator, publisher, dialect, limiter)
}

// OTLPMetricsHandler handles POST /v1/metrics.
//
// @Summary      Export OTLP metrics
// @Description  OTLP/HTTP metrics receiver. Accepts an ExportMetricsServiceRequest as protobuf (application/x-protobuf) or OTLP JSON (application/json), optionally gzip-compressed (Content-Encoding: gzip). Answers 200 with an ExportMetricsServiceResponse in the request's encoding whenever the body decodes; partialSuccess counts the data points Flightdeck did not map, with a message naming why. Error responses carry a google.rpc.Status in the request's encoding. The request is refused with 429 before it is read when the token's per-minute budget is spent, and is charged one unit per event it publishes.
// @Tags         otlp
// @Accept       json,application/x-protobuf
// @Produce      json,application/x-protobuf
// @Param        Authorization     header    string  true   "Bearer token"
// @Param        Content-Encoding  header    string  false  "gzip, or absent for an uncompressed body"
// @Param        request           body      object  true   "OTLP ExportMetricsServiceRequest"
// @Success      200  {object}  OTLPExportMetricsResponse
// @Failure      400  {object}  OTLPStatus  "body does not decode"
// @Failure      401  {object}  OTLPStatus  "missing or invalid bearer token"
// @Failure      413  {object}  OTLPStatus  "body over 4 MiB, or over 16 MiB decompressed"
// @Failure      415  {object}  OTLPStatus  "media type or content encoding not supported"
// @Failure      429  {object}  OTLPStatus  "rate limit exceeded; see Retry-After"
// @Failure      500  {object}  OTLPStatus  "token validation failed"
// @Header       429  {integer}  Retry-After  "seconds until the token's minute budget has room"
// @Failure      503  {object}  OTLPStatus  "publishing the mapped events failed; retry"
// @Router       /v1/metrics [post]
func OTLPMetricsHandler(validator TokenValidator, publisher EventPublisher, dialect OTLPDialect, limiter *RateLimiter) http.HandlerFunc {
	return otlpHandler(otlpMetricsSignal, validator, publisher, dialect, limiter)
}

// otlpHandler is the OTLP/HTTP receiver for one signal. The order of
// its checks: bearer token (401), the token's minute budget (429, with
// nothing read or charged), media type and content encoding (415), the
// size limits while reading (413), decoding (400). A body that decodes
// is answered 200 with partial_success counting the records the
// dialect did not use; a failed publish of the events it did map is
// 503, which OTLP exporters retry.
func otlpHandler(
	sig otlpSignal,
	validator TokenValidator,
	publisher EventPublisher,
	dialect OTLPDialect,
	limiter *RateLimiter,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		enc, mediaOK := otlpRequestEncoding(r)
		fail := func(status int, code int32, msg string) {
			writeOTLPStatus(w, enc, status, code, msg)
			slog.Info("otlp export refused",
				"signal", sig.name, "status", status, "reason", msg)
		}

		token := extractBearerToken(r)
		if token == "" {
			fail(http.StatusUnauthorized, grpcCodeUnauthenticated, "missing bearer token")
			return
		}
		result, err := validator.Validate(ctx, token)
		if err != nil {
			slog.Error("token validation error", "err", err)
			fail(http.StatusInternalServerError, grpcCodeInternal, "internal server error")
			return
		}
		if !result.Valid {
			reason := result.Reason
			if reason == "" {
				reason = "invalid token"
			}
			fail(http.StatusUnauthorized, grpcCodeUnauthenticated, reason)
			return
		}

		// Gate on the minute budget before reading the body; the
		// request is charged only for the events it publishes.
		if limiter != nil {
			if allowed, retryAfter := limiter.AllowN(token, 0); !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
				fail(http.StatusTooManyRequests, grpcCodeResourceExhausted, "rate limit exceeded")
				return
			}
		}

		if !mediaOK {
			fail(http.StatusUnsupportedMediaType, grpcCodeInvalidArgument,
				"content type must be "+otlpMediaProtobuf+" or "+otlpMediaJSON)
			return
		}
		gzipped, encodingOK := otlpContentEncoding(r)
		if !encodingOK {
			fail(http.StatusUnsupportedMediaType, grpcCodeInvalidArgument,
				"content encoding must be gzip or none")
			return
		}

		body, status, msg := readOTLPBody(r, gzipped)
		if status != 0 {
			code := grpcCodeInvalidArgument
			if status == http.StatusRequestEntityTooLarge {
				code = grpcCodeResourceExhausted
			}
			fail(status, code, msg)
			return
		}

		req := sig.newRequest()
		if enc == otlpEncodingProtobuf {
			err = proto.Unmarshal(body, req)
		} else {
			err = unmarshalOTLPJSON(body, req)
		}
		if err != nil {
			fail(http.StatusBadRequest, grpcCodeInvalidArgument,
				"request body is not a valid OTLP "+sig.name+" export request")
			return
		}

		mapping := sig.mapRequest(ctx, dialect, req)

		published, err := publishOTLPEvents(publisher, mapping.Events)
		if limiter != nil {
			limiter.ChargeN(token, published)
		}
		if err != nil {
			slog.Error("otlp publish failed",
				"signal", sig.name, "published", published,
				"events", len(mapping.Events), "err", err)
			fail(http.StatusServiceUnavailable, grpcCodeUnavailable,
				"publishing events failed; retry the export")
			return
		}

		writeOTLPMessage(w, enc, http.StatusOK, sig.response(mapping))
		slog.Info("otlp export",
			"signal", sig.name, "status", http.StatusOK,
			"published", published, "rejected", mapping.Rejected)
	}
}

// errOTLPPublishGivenUp reports a publish the publisher gave up on: it
// returned no error but no stream sequence either.
type errOTLPPublishGivenUp struct{ subject string }

func (e errOTLPPublishGivenUp) Error() string {
	return "publish to " + e.subject + " was given up on"
}

// publishOTLPEvents publishes events in order and returns how many it
// published before the first failure. A publish that reports no stream
// sequence was given up on by the publisher and counts as a failure,
// so the exporter retries the request rather than losing its events;
// the events' deterministic ids make the retry safe.
func publishOTLPEvents(publisher EventPublisher, events []OTLPEvent) (int, error) {
	for i, ev := range events {
		subject := inats.SubjectForEventType(ev.EventType)
		seq, err := publisher.Publish(subject, ev.Payload)
		if err != nil {
			return i, err
		}
		if seq == 0 {
			return i, errOTLPPublishGivenUp{subject: subject}
		}
	}
	return len(events), nil
}

// otlpRequestEncoding reports the request's OTLP encoding from its
// Content-Type and whether that is a supported media type. An
// unsupported one is answered in JSON.
func otlpRequestEncoding(r *http.Request) (otlpEncoding, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return otlpEncodingJSON, false
	}
	switch mediaType {
	case otlpMediaProtobuf:
		return otlpEncodingProtobuf, true
	case otlpMediaJSON:
		return otlpEncodingJSON, true
	}
	return otlpEncodingJSON, false
}

// otlpContentEncoding reports whether the body is gzip-compressed and
// whether its Content-Encoding is supported (gzip, identity or none).
func otlpContentEncoding(r *http.Request) (gzipped, ok bool) {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))) {
	case "":
		return false, true
	case "identity":
		return false, true
	case "gzip":
		return true, true
	}
	return false, false
}

// readOTLPBody reads the request body within the size limits and
// decompresses it when gzipped. It returns the body, or a non-zero
// HTTP status and a message: 413 past either limit, 400 for a body
// that cannot be read or does not decompress. The decompressed limit
// is enforced while decompressing, so a bomb is never inflated past it.
func readOTLPBody(r *http.Request, gzipped bool) ([]byte, int, string) {
	if r.ContentLength > maxOTLPCompressedBytes {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 4 MiB"
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxOTLPCompressedBytes+1))
	if err != nil {
		return nil, http.StatusBadRequest, "unable to read request body"
	}
	if len(raw) > maxOTLPCompressedBytes {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 4 MiB"
	}
	if !gzipped {
		return raw, 0, ""
	}

	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, http.StatusBadRequest, "request body is not valid gzip"
	}
	defer func() { _ = zr.Close() }()
	body, err := io.ReadAll(io.LimitReader(zr, maxOTLPDecompressedBytes+1))
	if err != nil {
		return nil, http.StatusBadRequest, "request body is not valid gzip"
	}
	if len(body) > maxOTLPDecompressedBytes {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 16 MiB decompressed"
	}
	return body, 0, ""
}

// writeOTLPMessage writes an OTLP response message in enc.
func writeOTLPMessage(w http.ResponseWriter, enc otlpEncoding, status int, msg proto.Message) {
	var (
		body []byte
		err  error
	)
	if enc == otlpEncodingProtobuf {
		body, err = proto.Marshal(msg)
	} else {
		body, err = protojson.Marshal(msg)
	}
	if err != nil {
		slog.Error("encode OTLP response", "err", err)
		writeOTLPStatus(w, enc, http.StatusInternalServerError, grpcCodeInternal, "internal server error")
		return
	}
	writeOTLPBody(w, enc, status, body)
}

// writeOTLPStatus writes an OTLP error response: a google.rpc.Status
// with the gRPC code and message, in enc. Status is encoded by hand
// (code is field 1, message field 2) rather than through the genproto
// module, which would be a dependency for two fields.
func writeOTLPStatus(w http.ResponseWriter, enc otlpEncoding, status int, code int32, msg string) {
	var body []byte
	if enc == otlpEncodingProtobuf {
		body = protowire.AppendTag(body, 1, protowire.VarintType)
		body = protowire.AppendVarint(body, uint64(code))
		body = protowire.AppendTag(body, 2, protowire.BytesType)
		body = protowire.AppendString(body, msg)
	} else {
		body, _ = json.Marshal(OTLPStatus{Code: code, Message: msg})
	}
	writeOTLPBody(w, enc, status, body)
}

func writeOTLPBody(w http.ResponseWriter, enc otlpEncoding, status int, body []byte) {
	contentType := otlpMediaJSON
	if enc == otlpEncodingProtobuf {
		contentType = otlpMediaProtobuf
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
