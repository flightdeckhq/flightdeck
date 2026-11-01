package handlers

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
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

// Decode cost. Decoding allocates far more than the body for some
// shapes: a protobuf message can be two bytes on the wire and a few
// hundred bytes in memory, so 16 MiB of empty messages would decode
// into gigabytes. Before decoding, the receiver estimates the heap the
// decode will take: the body (strings are copied out of it) plus a
// cost per message and per scalar element, the costs measured with
// runtime.MemStats over the OTLP message types and rounded up (the
// largest message, an empty Span, took 334 bytes from protobuf and 358
// from JSON; a JSON scalar took 74 bytes and a packed varint 9). A
// request whose estimate passes maxOTLPDecodeHeapBytes is refused with
// 413. 48 MiB admits any realistic export: a full 512-record batch of
// Claude Code log records, about 30 attributes each, estimates at about
// 20 MiB, and a 16 MiB body of prompt text at little over 16 MiB.
const (
	maxOTLPDecodeHeapBytes  = 48 << 20
	otlpHeapPerMessage      = 512
	otlpHeapPerJSONScalar   = 128
	otlpHeapPerPackedScalar = 16
)

// maxOTLPNestingDepth bounds how deeply a request may nest objects,
// arrays or messages; deeper is a 400. OTLP nests a log record or span
// seven levels below the request, and attribute values nest further
// only through kvlist and array values, which no exporter nests more
// than a few levels. 128 leaves ample room while keeping the walks
// that estimate the decode cost shallow and their stacks small.
const maxOTLPNestingDepth = 128

// Decode concurrency. Each request inflates, decodes and maps its body
// while holding one of otlpDecodeSlots, so what OTLP decoding holds in
// memory at once is bounded by otlpDecodeMemoryBudget whatever the
// traffic. A slot is sized for the worst request admitted: its body as
// sent, inflated, and decoded at the estimate cap. The budget is half
// the Helm chart's default 512 MiB ingestion memory limit, leaving the
// rest for /v1/events and the runtime; it gives 3 slots, which is no
// constraint on throughput because decoding is CPU-bound and an
// ingestion pod runs on at most one CPU. A request that finds no slot
// free within otlpDecodeSlotWait is answered 503 with Retry-After
// otlpDecodeRetryAfterSeconds, which OTLP exporters honour.
const (
	otlpDecodeWorstCaseBytes    = maxOTLPCompressedBytes + maxOTLPDecompressedBytes + maxOTLPDecodeHeapBytes
	otlpDecodeMemoryBudget      = 256 << 20
	otlpDecodeSlots             = otlpDecodeMemoryBudget / otlpDecodeWorstCaseBytes
	otlpDecodeSlotWait          = 2 * time.Second
	otlpDecodeRetryAfterSeconds = 1
)

// errOTLPDecodeTooLarge marks a request whose decode would pass
// maxOTLPDecodeHeapBytes (413).
var errOTLPDecodeTooLarge = errors.New("request decodes past the receiver's memory limit")

// otlpDecodeGate is the global semaphore of decode slots shared by the
// three OTLP routes.
type otlpDecodeGate struct {
	slots chan struct{}
	wait  time.Duration
}

func newOTLPDecodeGate(slots int, wait time.Duration) *otlpDecodeGate {
	return &otlpDecodeGate{slots: make(chan struct{}, slots), wait: wait}
}

// otlpDecodes is the process-wide decode gate.
var otlpDecodes = newOTLPDecodeGate(otlpDecodeSlots, otlpDecodeSlotWait)

// acquire takes a slot, waiting at most g.wait; it reports false when
// none came free or ctx ended first.
func (g *otlpDecodeGate) acquire(ctx context.Context) bool {
	select {
	case g.slots <- struct{}{}:
		return true
	default:
	}
	timer := time.NewTimer(g.wait)
	defer timer.Stop()
	select {
	case g.slots <- struct{}{}:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (g *otlpDecodeGate) release() { <-g.slots }

// readCapped reads r to EOF into a buffer first sized for hint bytes,
// and reports over, with nothing returned, once it holds more than
// limit. A short hint grows the buffer by doubling, never past
// limit+1.
func readCapped(r io.Reader, hint, limit int) (b []byte, over bool, err error) {
	buf := make([]byte, 0, min(max(hint, 0), limit)+1)
	for {
		if len(buf) == cap(buf) {
			if len(buf) > limit {
				return nil, true, nil
			}
			grown := make([]byte, len(buf), min(2*cap(buf), limit+1))
			copy(grown, buf)
			buf = grown
		}
		n, err := r.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if errors.Is(err, io.EOF) {
			if len(buf) > limit {
				return nil, true, nil
			}
			return buf, false, nil
		}
		if err != nil {
			return nil, false, err
		}
	}
}

// otlpInitialReadBytes sizes the first read buffer of a body sent
// without a Content-Length; it grows from there. Sizing it up front
// from the declared length instead would let a client that declares
// 4 MiB and sends nothing make the receiver allocate 4 MiB.
const otlpInitialReadBytes = 64 << 10

// readOTLPBody reads the request body as sent, within
// maxOTLPCompressedBytes. It returns the body, or a non-zero HTTP
// status and a message: 413 past the limit, 400 for a body that
// cannot be read.
func readOTLPBody(r *http.Request) ([]byte, int, string) {
	if r.ContentLength > maxOTLPCompressedBytes {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 4 MiB"
	}
	hint := otlpInitialReadBytes
	if r.ContentLength >= 0 {
		hint = min(int(r.ContentLength), otlpInitialReadBytes)
	}
	raw, over, err := readCapped(r.Body, hint, maxOTLPCompressedBytes)
	if err != nil {
		return nil, http.StatusBadRequest, "unable to read request body"
	}
	if over {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 4 MiB"
	}
	return raw, 0, ""
}

// gzipTrailerSizeBytes is the length of the ISIZE field that ends a
// gzip stream: the uncompressed size modulo 2^32, little-endian.
const gzipTrailerSizeBytes = 4

// inflateOTLPBody decompresses a gzip body into a buffer sized exactly
// from its ISIZE trailer, so inflating never copies or over-allocates.
// A stream whose trailer declares more than maxOTLPDecompressedBytes is
// refused with 413 before anything is inflated, and one that inflates
// to anything but what it declares is not valid gzip (400): inflating
// stops one byte past the declared size, so a false trailer cannot
// inflate past the limit. Exporters send one gzip member, whose
// trailer holds the whole size.
func inflateOTLPBody(raw []byte) ([]byte, int, string) {
	// The header is checked first, so a body that is not gzip at all
	// is a 400 whatever its last bytes say.
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil || len(raw) < gzipTrailerSizeBytes {
		return nil, http.StatusBadRequest, "request body is not valid gzip"
	}
	defer func() { _ = zr.Close() }()
	declared := binary.LittleEndian.Uint32(raw[len(raw)-gzipTrailerSizeBytes:])
	if declared > maxOTLPDecompressedBytes {
		return nil, http.StatusRequestEntityTooLarge, "request body exceeds 16 MiB decompressed"
	}
	body, over, err := readCapped(zr, int(declared), int(declared))
	if err != nil || over || len(body) != int(declared) {
		return nil, http.StatusBadRequest, "request body is not valid gzip"
	}
	return body, 0, ""
}

// decodeOTLPRequest decodes body into req in enc, first estimating the
// heap the decode takes. It returns 0, or 413 for a request whose
// estimate passes maxOTLPDecodeHeapBytes and 400 for one that does not
// decode. A JSON body is rewritten in place.
func decodeOTLPRequest(enc otlpEncoding, body []byte, req proto.Message) (int, string) {
	var err error
	if enc == otlpEncodingProtobuf {
		if _, err = estimateOTLPProtobuf(body, req.ProtoReflect().Descriptor()); err == nil {
			err = proto.Unmarshal(body, req)
		}
	} else {
		err = unmarshalOTLPJSON(body, req)
	}
	switch {
	case err == nil:
		return 0, ""
	case errors.Is(err, errOTLPDecodeTooLarge):
		return http.StatusRequestEntityTooLarge, errOTLPDecodeTooLarge.Error()
	default:
		return http.StatusBadRequest, ""
	}
}

// estimateOTLPProtobuf walks a protobuf body by its message descriptor,
// allocating nothing, and refuses one whose decode would pass
// maxOTLPDecodeHeapBytes or that nests deeper than
// maxOTLPNestingDepth. A body that is not valid protobuf wire format is
// an error too, caught here before decoding.
func estimateOTLPProtobuf(body []byte, md protoreflect.MessageDescriptor) (int64, error) {
	heap := int64(len(body))
	err := walkOTLPProtobuf(body, md, 0, &heap)
	return heap, err
}

func walkOTLPProtobuf(b []byte, md protoreflect.MessageDescriptor, depth int, heap *int64) error {
	if depth >= maxOTLPNestingDepth {
		return fmt.Errorf("protobuf nested deeper than %d", maxOTLPNestingDepth)
	}
	fields := md.Fields()
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return protowire.ParseError(n)
		}
		b = b[n:]
		fd := fields.ByNumber(num)
		if fd != nil && typ == protowire.BytesType {
			if fd.Kind() == protoreflect.MessageKind {
				v, m := protowire.ConsumeBytes(b)
				if m < 0 {
					return protowire.ParseError(m)
				}
				*heap += otlpHeapPerMessage
				if *heap > maxOTLPDecodeHeapBytes {
					return errOTLPDecodeTooLarge
				}
				if err := walkOTLPProtobuf(v, fd.Message(), depth+1, heap); err != nil {
					return err
				}
				b = b[m:]
				continue
			}
			if fd.IsList() && packedElemSize(fd.Kind()) >= 0 {
				v, m := protowire.ConsumeBytes(b)
				if m < 0 {
					return protowire.ParseError(m)
				}
				*heap += int64(packedElements(v, packedElemSize(fd.Kind()))) * otlpHeapPerPackedScalar
				if *heap > maxOTLPDecodeHeapBytes {
					return errOTLPDecodeTooLarge
				}
				b = b[m:]
				continue
			}
		}
		if fd != nil && fd.IsList() {
			// One element of an unpacked repeated field.
			*heap += otlpHeapPerPackedScalar
			if *heap > maxOTLPDecodeHeapBytes {
				return errOTLPDecodeTooLarge
			}
		}
		m := protowire.ConsumeFieldValue(num, typ, b)
		if m < 0 {
			return protowire.ParseError(m)
		}
		b = b[m:]
	}
	return nil
}

// packedElemSize is the wire size of one element of a packed repeated
// field of kind k: 0 for varints, 4 or 8 for fixed-size kinds, -1 for
// kinds that cannot be packed.
func packedElemSize(k protoreflect.Kind) int {
	switch k {
	case protoreflect.BoolKind, protoreflect.EnumKind,
		protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Uint32Kind,
		protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Uint64Kind:
		return 0
	case protoreflect.Fixed32Kind, protoreflect.Sfixed32Kind, protoreflect.FloatKind:
		return 4
	case protoreflect.Fixed64Kind, protoreflect.Sfixed64Kind, protoreflect.DoubleKind:
		return 8
	}
	return -1
}

// packedElements counts the elements of a packed field's payload: the
// bytes that end a varint, or the payload over the fixed size.
func packedElements(v []byte, size int) int {
	if size > 0 {
		return len(v) / size
	}
	n := 0
	for _, c := range v {
		if c < 0x80 {
			n++
		}
	}
	return n
}
