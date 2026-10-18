# Security

## Reporting

Report security or privacy issues privately to the repository owner. Do not open
a public issue with credentials, session content, or a working exploit.

## Local route

`/composer-predict/*` is a localhost same-origin route in the DSH webserver. It
is not an authenticated public API. ACE never writes a session and never sends
the evidence pack anywhere except the selected model route.

## Evidence pack

The host runs read-only `git -C <session cwd>` commands (status, diff stat,
staged stat, last commit, bounded diff). It does not run a shell command from the
transcript. If DSH is exposed beyond localhost, review the webserver trust
boundary and the route before doing so.

## Diagnostics

Parse failures record only the stage, error message, and raw output length;
model output and transcript content are not persisted. Treat the diagnostics
directory as private and do not upload it to an issue.

## Supported versions

Security fixes target the latest tagged release and the DSH version declared in
`package.json.dsh.compatibility`.
