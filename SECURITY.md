# Security policy

## Supported versions

Until the first stable Chrome Web Store release, security fixes are made on the
latest released version and the default development branch only.

## Reporting a vulnerability

Please do not open a public issue containing exploit details, credentials,
personal data, or a proof of concept against the deployed service.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/RemasteredGod/Wick-/security/advisories/new

If that form is unavailable, open a public issue that asks the maintainer for a
private security contact without describing the vulnerability.

Include the affected version or commit, impacted component, reproduction steps,
impact, and any suggested mitigation. Use placeholder accounts and redact
Claude organisation IDs, email addresses, bearer tokens, Supabase keys, request
bodies, and conversation content.

You can expect an acknowledgement within seven days. The maintainer will
coordinate validation, remediation, release, and disclosure. Please allow a fix
to be prepared before publishing details.

## Scope

Security reports are welcome for the Chrome extension, optional leaderboard,
Vercel functions, Supabase schema, build/release pipeline, and privacy-boundary
violations. The leaderboard is explicitly self-reported and does not verify
ownership of a submitted Claude account email; that documented limitation alone
is not a vulnerability, but an undisclosed way to expose private data or exceed
its stated impact is.
