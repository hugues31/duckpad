"""Listing one level of an S3-compatible bucket with the settings a connection gives DuckDB."""

from datetime import UTC, datetime

import httpx2
import pytest

from duckpad import s3_listing
from duckpad.builtin_connectors import BUILTIN_CONNECTORS
from duckpad.util import Problem

VALUES = {
    "root": "s3://lake/raw",
    "key_id": "key",
    "secret": "hidden-value",
    "region": "eu-west-3",
    "endpoint": "minio.internal:9000",
    "use_ssl": False,
    "url_style": "path",
}


def page(*keys, prefixes=(), truncated=False, prefix="raw/"):
    """A ListObjectsV2 answer, URL-encoded as requested."""
    contents = "".join(
        f"<Contents><Key>{key}</Key><LastModified>2026-11-17T07:25:29.000Z</LastModified>"
        f"<Size>{len(key)}</Size></Contents>"
        for key in keys
    )
    folders = "".join(f"<CommonPrefixes><Prefix>{p}</Prefix></CommonPrefixes>" for p in prefixes)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<Name>lake</Name><Prefix>{prefix}</Prefix><IsTruncated>{str(truncated).lower()}</IsTruncated>"
        f"{contents}{folders}</ListBucketResult>"
    )


def error(code, message="refused"):
    return f"<Error><Code>{code}</Code><Message>{message}</Message></Error>"


@pytest.fixture
def storage(monkeypatch):
    """Answers each listing request with the next queued (status, body), keeping the requests."""
    answers, requests = [], []

    def handle(request):
        requests.append(request)
        if not answers:
            raise httpx2.ConnectError("Connection refused", request=request)
        status, body = answers.pop(0)
        return httpx2.Response(status, text=body)

    original = httpx2.Client
    monkeypatch.setattr(
        httpx2, "Client", lambda **kwargs: original(transport=httpx2.MockTransport(handle), **kwargs)
    )
    return answers, requests


def settings(**values):
    return s3_listing.client_settings(BUILTIN_CONNECTORS["s3"], {**VALUES, **values})


def test_the_builtin_connector_signs_with_its_connection_values():
    assert settings() == {
        "key_id": "key",
        "secret": "hidden-value",
        "session_token": "",
        "region": "eu-west-3",
        "endpoint": "minio.internal:9000",
        "use_ssl": False,
        "url_style": "path",
    }
    assert settings(use_ssl=True)["use_ssl"] is True


def test_a_custom_connector_lists_with_its_literals_and_parameter_names():
    definition = {
        "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE S3, KEY_ID {{ access }}, "
        "SECRET {{ password }}, ENDPOINT 'objects.example.com:8443', USE_SSL false, URL_STYLE 'path', "
        "SCOPE 's3://landing,archive');"
    }
    found = s3_listing.client_settings(definition, {"access": "AK", "password": "PW"})
    assert found == {**s3_listing.DEFAULTS, "key_id": "AK", "secret": "PW", "use_ssl": False} | {
        "endpoint": "objects.example.com:8443",
        "url_style": "path",
    }


@pytest.mark.parametrize(
    "init_sql",
    [
        "",
        "CREATE SECRET (TYPE GCS, KEY_ID {{ key }}, SECRET {{ secret }});",
        "CREATE SECRET {{ secret_name }} (TYPE S3, PROVIDER credential_chain);",
        "CREATE SECRET (TYPE S3, KEY_ID concat('a', 'b'));",
    ],
)
def test_other_storage_setups_have_no_listing(init_sql):
    assert s3_listing.client_settings({"init_sql": init_sql}, {"key": "k", "secret": "s"}) is None


def test_requests_carry_an_aws_signature_version_4():
    # The documented "GET Bucket (List Objects)" example of the AWS Signature Version 4 reference.
    signed = s3_listing.signed_headers(
        {
            **s3_listing.DEFAULTS,
            "key_id": "AKIAIOSFODNN7EXAMPLE",
            "secret": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
        "examplebucket.s3.amazonaws.com",
        "/",
        "max-keys=2&prefix=J",
        datetime(2013, 5, 24, tzinfo=UTC),
    )
    assert signed["authorization"].endswith(
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
        "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
    )
    anonymous = s3_listing.signed_headers(
        {**s3_listing.DEFAULTS, "session_token": "token"}, "h", "/", "", datetime(2013, 5, 24, tzinfo=UTC)
    )
    assert "authorization" not in anonymous and anonymous["x-amz-security-token"] == "token"


def test_a_level_lists_folders_then_files_with_decoded_names(storage):
    answers, requests = storage
    answers.append(
        (
            200,
            page(
                "raw/2024/",
                "raw/2024/orders.csv",
                "raw/2024/file+with+space.csv",
                "raw/2024/accentu%C3%A9.csv",
                "raw/2024/a%2Bb.csv",
                "raw/2024/.hidden.csv",
                prefix="raw/2024/",
                prefixes=["raw/2024/q1/", "raw/2024/.cache/"],
            ),
        )
    )
    listed = s3_listing.list_level(settings(), "s3://lake/raw", "2024", "", 1000)
    assert [(entry["kind"], entry["name"]) for entry in listed["entries"]] == [
        ("folder", "q1"),
        ("file", "a+b.csv"),
        ("file", "accentué.csv"),
        ("file", "file with space.csv"),
        ("file", "orders.csv"),
    ]
    assert listed["entries"][-1]["modified"] == "2026-11-17T07:25:29+00:00"
    assert listed["truncated"] is False
    (request,) = requests
    # Path-style addressing over HTTP, one level below the root, signed for the configured region.
    assert str(request.url).startswith("http://minio.internal:9000/lake?")
    assert dict(request.url.params) == {
        "delimiter": "/",
        "encoding-type": "url",
        "list-type": "2",
        "max-keys": "1000",
        "prefix": "raw/2024/",
    }
    assert "/eu-west-3/s3/aws4_request" in request.headers["authorization"]
    assert request.headers["host"] == "minio.internal:9000"


def test_virtual_hosted_requests_name_the_bucket_in_the_host(storage):
    answers, requests = storage
    answers.append((200, page(prefix="")))
    s3_listing.list_level(settings(url_style="vhost", use_ssl=True), "s3://lake/", "", "ord", 10)
    assert str(requests[0].url).startswith("https://lake.minio.internal:9000/?")
    assert requests[0].url.params["prefix"] == "ord"


def test_an_empty_folder_marker_or_a_hidden_file_is_a_folder_and_a_missing_prefix_is_not(storage):
    answers, _ = storage
    answers.append((200, page("raw/empty/", prefix="raw/empty/")))
    assert s3_listing.list_level(settings(), "s3://lake/raw", "empty", "", 10) == {
        "entries": [],
        "truncated": False,
    }
    # A folder holding hidden files only exists, even with nothing to show.
    answers.append((200, page("raw/kept/.keep", prefix="raw/kept/")))
    assert s3_listing.list_level(settings(), "s3://lake/raw", "kept", "", 10)["entries"] == []
    answers.append((200, page(prefix="raw/missing/")))
    with pytest.raises(Problem, match="This folder does not exist in the bucket") as missing:
        s3_listing.list_level(settings(), "s3://lake/raw", "missing", "", 10)
    assert missing.value.status == 404


@pytest.mark.parametrize(
    ("status", "body", "message", "code"),
    [
        (404, error("NoSuchBucket"), "The bucket lake does not exist on this endpoint", 404),
        (403, error("AccessDenied"), r"need the s3:ListBucket permission\. Enter the path", 422),
        (
            403,
            error("SignatureDoesNotMatch"),
            r"refused the connection's credentials \(SignatureDoesNotMatch\)",
            422,
        ),
        (301, error("PermanentRedirect"), "answers on another region or endpoint", 422),
        (503, error("SlowDown", "Reduce your request rate"), r"refused the listing \(SlowDown: Reduce", 422),
        (502, "<html>Bad gateway</html>", r"refused the listing \(HTTP 502\)", 422),
        (200, "not xml", r"refused the listing \(HTTP 200\)", 422),
    ],
)
def test_refusals_explain_what_to_check(storage, status, body, message, code):
    answers, _ = storage
    answers.append((status, body))
    with pytest.raises(Problem, match=message) as refused:
        s3_listing.list_level(settings(), "s3://lake/raw", "", "", 10)
    assert refused.value.status == code


def test_an_unreachable_endpoint_or_an_oversized_answer_is_reported(storage, monkeypatch):
    answers, _ = storage
    with pytest.raises(Problem, match=r"cannot reach the storage endpoint minio\.internal:9000"):
        s3_listing.list_level(settings(), "s3://lake/raw", "", "", 10)
    monkeypatch.setattr(s3_listing, "MAX_RESPONSE_BYTES", 100)
    answers.append((200, page(*[f"raw/{n}.csv" for n in range(10)])))
    with pytest.raises(Problem, match="answer too large"):
        s3_listing.list_level(settings(), "s3://lake/raw", "", "", 10)


@pytest.mark.parametrize("root", ["s3:///raw", "gs://lake/raw", "https://lake.example.com/raw"])
def test_roots_without_a_bucket_or_of_another_scheme_are_refused(root):
    with pytest.raises(Problem) as refused:
        s3_listing.list_level(settings(), root, "", "", 10)
    assert refused.value.status == 422
