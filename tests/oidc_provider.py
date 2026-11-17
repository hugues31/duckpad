"""Disposable OIDC provider for protocol and browser tests; never used by the app."""

import base64
import hashlib
import html
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx2
from fastapi import FastAPI, Request, Response
from joserfc import jwt
from joserfc.jwk import RSAKey


class Provider:
    def __init__(self, issuer="https://identity.example.com"):
        self.issuer = issuer
        self.key = RSAKey.generate_key(2048, {"kid": "test-key"})
        self.codes = {}
        self.claims = {}
        self.signing_key = None
        self.algorithm = "RS256"
        self.method = "client_secret_basic"
        self.metadata = {}
        self.requests = []

    def handle(self, request):
        self.requests.append(request)
        path = request.url.path.removeprefix(urlsplit(self.issuer).path)
        if path == "/.well-known/openid-configuration":
            return httpx2.Response(
                200,
                json={
                    "issuer": self.issuer,
                    "authorization_endpoint": self.issuer + "/authorize",
                    "token_endpoint": self.issuer + "/token",
                    "jwks_uri": self.issuer + "/jwks",
                    "response_types_supported": ["code"],
                    "id_token_signing_alg_values_supported": ["RS256"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": [self.method],
                    **self.metadata,
                },
            )
        if path == "/jwks":
            return httpx2.Response(200, json={"keys": [self.key.as_dict(private=False)]})
        if path == "/authorize":
            params = dict(request.url.params)
            code = secrets.token_urlsafe(24)
            self.codes[code] = params
            callback = (
                params["redirect_uri"]
                + "?"
                + urlencode({"code": code, "state": params["state"], "iss": self.issuer})
            )
            return httpx2.Response(
                200,
                headers={"content-type": "text/html"},
                text=(
                    '<html lang="en"><title>Test identity provider</title><h1>Test identity provider</h1>'
                    f'<a href="{html.escape(callback)}">Approve test sign-in</a></html>'
                ),
            )
        if path == "/token":
            data = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            auth = "Basic " + base64.b64encode(b"test-client:test-secret").decode()
            if self.method == "client_secret_basic":
                assert request.headers["authorization"] == auth
            else:
                assert data["client_id"] == "test-client" and data["client_secret"] == "test-secret"
            params = self.codes.pop(data["code"])
            assert data["grant_type"] == "authorization_code"
            assert data["redirect_uri"] == params["redirect_uri"]
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            assert params["code_challenge_method"] == "S256" and challenge == params["code_challenge"]
            claims = {
                "iss": self.issuer,
                "sub": "subject-123",
                "aud": "test-client",
                "nonce": params["nonce"],
                "iat": int(time.time()),
                "exp": int(time.time()) + 300,
                "preferred_username": "admin",
                **self.claims,
            }
            for key in [key for key, value in claims.items() if value is None]:
                del claims[key]
            encoded = jwt.encode(
                {"alg": self.algorithm, "kid": "test-key"}, claims, self.signing_key or self.key
            )
            return httpx2.Response(
                200, json={"id_token": encoded, "access_token": "test-access-token", "token_type": "Bearer"}
            )
        return httpx2.Response(404)

    def application(self):
        app = FastAPI()

        @app.api_route("/{path:path}", methods=["GET", "POST"])
        async def handle(request: Request):
            response = self.handle(
                httpx2.Request(
                    request.method,
                    str(request.url),
                    headers=dict(request.headers),
                    content=await request.body(),
                )
            )
            return Response(
                response.content, status_code=response.status_code, headers=dict(response.headers)
            )

        return app
