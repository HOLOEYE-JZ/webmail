# Mobile sign-in hand-off with a one-time code

The Bulwark mobile app can sign in through the webmail's login page in the
system browser. Until now the page opened the app's callback link with the
sign-in in the fragment (`flow=password` with the password, or `flow=oauth`
with the tokens). Any app on the device can register the `bulwarkmobile`
scheme, so that link can be caught by someone else.

With a PKCE challenge the link carries only a one-time code. The sign-in
stays on the webmail server until the app redeems the code with the matching
verifier. Without a challenge the page behaves as before, so older app builds
keep working.

## 1. Open the login page

```
GET <webmail>/<locale>/login
    ?mobile_redirect_uri=bulwarkmobile://auth/callback
    &mobile_state=<opaque, up to 512 chars>
    &mobile_code_challenge=<S256 challenge>
```

- `mobile_code_challenge` is `BASE64URL(SHA256(code_verifier))` without
  padding, exactly 43 characters (RFC 7636, method S256 only). The verifier is
  43 to 128 characters from `A-Z a-z 0-9 - . _ ~`. Use a fresh verifier for
  every sign-in.
- A challenge that is present but malformed makes the page ignore the
  hand-off: it acts as a normal sign-in page and gives the app nothing.
- `mobile_redirect_uri` must be exactly `bulwarkmobile://auth/callback`, as
  before.

This works for the password form and for SSO/OAuth sign-in (the page routes
mobile OAuth through the server-side SSO flow). Bulwark Lite has no server to
keep the sign-in on; it ignores the challenge and still uses the fragment.

## 2. The callback link

After the user signs in and confirms the hand-off, the browser opens:

```
bulwarkmobile://auth/callback?code=<64 lowercase hex chars>&state=<mobile_state>
```

The parameters are in the query string, not the fragment. There is no
`flow`, no server URL and no secret in the link. Check `state` against the
value you sent before redeeming.

A link with a fragment (`#flow=...`) means the webmail is older than this
change, or is a Lite build; handle it as before.

## 3. Redeem the code

```
POST <webmail>/api/auth/handoff/redeem
Content-Type: application/json

{ "code": "<code from the link>", "code_verifier": "<verifier>" }
```

The code is valid for 60 seconds from the moment the user confirmed the
hand-off in the browser, and works once. Send no `Origin` or
`Sec-Fetch-Site` header (native HTTP clients don't), or the same-origin check
answers 403.

### Success: 200

The same fields the fragment used to carry, as JSON. `state` is included so
existing fragment parsing can be reused.

```json
{
  "flow": "password",
  "server_url": "https://mail.example.org",
  "username": "alice@example.org",
  "password": "...",
  "state": "<mobile_state>"
}
```

```json
{
  "flow": "oauth",
  "server_url": "https://mail.example.org",
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3540,
  "token_endpoint": "https://mail.example.org/auth/token",
  "client_id": "bulwark-webmail",
  "state": "<mobile_state>"
}
```

- `expires_in` is a number (the fragment had a string) and counts from the
  redeem, not from the sign-in.
- `refresh_token` and `expires_in` are optional, as before.
- `token_endpoint` may point at the webmail's token proxy
  (`<webmail>/api/auth/pair/token`), with a sealed `refresh_token`, exactly
  like the old fragment and the QR pairing bundle.

### Errors

Every failure spends the code. Start a new sign-in after any of them.

| Status | `error`             | Meaning                                         |
| ------ | ------------------- | ----------------------------------------------- |
| 400    | `invalid_request`   | Body is not JSON or `code` is malformed         |
| 400    | `invalid_code`      | Never issued, already redeemed or tried         |
| 400    | `expired_code`      | Confirmed more than 60 seconds ago              |
| 400    | `invalid_verifier`  | Verifier malformed or does not match            |
| 429    | `too_many_requests` | More than 10 failed redeems from this address in 15 minutes |
| 403    |                     | Cross-origin browser request                    |

All responses carry `Cache-Control: no-store`.

## Webmail internals

- Store: `lib/auth/handoff-store.ts` (in-process, like the QR pairing store,
  so single-instance deployments or sticky sessions).
- Password flow: when the user confirms, the login page parks the sign-in at
  `POST /api/auth/handoff/create` and opens the link with the code it gets.
- SSO flow: `POST /api/auth/sso/start` takes `mobile_code_challenge` with the
  other mobile parameters. `POST /api/auth/sso/complete` parks the tokens
  itself and returns only `mobile_handoff_code`, so the tokens never reach
  the browser. That code waits up to five minutes for the user; when they
  confirm, the callback page calls `POST /api/auth/handoff/confirm`, which
  starts its 60 seconds, and opens the link.
