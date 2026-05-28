# Security Policy

## Supported Versions

Flightdeck is pre-1.0 and self-hosted. Security fixes are applied to the
latest released minor version only.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | ✅         |
| < 0.5   | ❌         |

## Reporting a Vulnerability

Please report suspected security vulnerabilities **privately**. Do not open a
public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/flightdeckhq/flightdeck/security/advisories/new>).

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally a minimal proof of concept.
- The affected component (`sensor`, `ingestion`, `api`, `workers`,
  `dashboard`, or `plugin`) and version.

We aim to acknowledge reports within 5 business days and to share a
remediation timeline after triage. We appreciate coordinated disclosure:
please allow up to 90 days for a fix to ship before disclosing publicly.

## Scope

Flightdeck's capture posture is privacy-sensitive: when `capture_prompts` is
disabled the system stores only metadata (token counts, model names, latency,
tool names) and never message content. The following are especially in scope:

- Prompt or message content being stored or logged while capture is disabled.
- Authentication or authorization bypass on the ingestion or query API.
- SQL injection, secret exposure, or credential leakage.
- Sensor behavior that could exfiltrate captured content to an unintended
  destination.
