"""Connector definitions shipped with each release.

The catalog serves these unless an instance administrator customized one: the edited definition is
then stored as an override, kept across upgrades until it is reset. An unedited built-in always
matches the running release.
"""

BUILTIN_CONNECTORS = {
    "folder": {
        "id": "folder",
        "name": "Server folder",
        "family": "storage",
        "description": "A folder on the Duckpad server, with a path for each environment.",
        "parameters": [{"name": "root", "type": "text", "default": ""}],
        "extensions": [],
        "init_sql": "",
        "capabilities": ["read", "write"],
        "compatibility": "Validated on DuckDB 2.0.0, Linux x86_64. Other DuckDB versions and platforms require validation.",
    },
    "s3": {
        "id": "s3",
        "name": "Amazon S3",
        "family": "storage",
        "description": "S3-compatible object storage, with a bucket prefix and credentials for each environment.",
        "parameters": [
            {"name": "root", "type": "text", "default": ""},
            {"name": "key_id", "type": "text", "secret": True},
            {"name": "secret", "type": "text", "secret": True},
            {"name": "region", "type": "text", "default": "us-east-1"},
            {"name": "endpoint", "type": "text", "default": "s3.amazonaws.com"},
            {"name": "use_ssl", "type": "boolean", "default": True},
            {"name": "url_style", "type": "text", "default": "vhost"},
        ],
        "extensions": [{"name": "httpfs"}],
        "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE S3, KEY_ID {{ key_id }}, SECRET {{ secret }}, REGION {{ region }}, ENDPOINT {{ endpoint }}, USE_SSL {{ use_ssl }}, URL_STYLE {{ url_style }});",
        "capabilities": ["read", "write"],
        "compatibility": "Validated on DuckDB 2.0.0 with matching httpfs, Linux x86_64, and a Moto S3 endpoint. Live AWS IAM/TLS behavior requires deployment validation.",
    },
    "postgres": {
        "id": "postgres",
        "name": "PostgreSQL",
        "family": "database",
        "description": "A PostgreSQL database, with its server, database and credentials for each environment.",
        "parameters": [
            {"name": "host", "type": "text"},
            {"name": "port", "type": "number", "default": 5432},
            {"name": "database", "type": "text"},
            {"name": "user", "type": "text"},
            {"name": "password", "type": "text", "secret": True},
            {
                "name": "options",
                "type": "text",
                "default": "",
                "label": "Additional options",
                "description": "libpq keywords passed to the driver as is, such as sslmode=verify-full application_name=duckpad.",
            },
        ],
        "extensions": [{"name": "postgres"}],
        "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE postgres, HOST {{ host }}, PORT {{ port }}, DATABASE {{ database }}, USER {{ user }}, PASSWORD {{ password }}); ATTACH {{ options }} AS {{ alias }} (TYPE postgres, SECRET {{ secret_name }});",
        "capabilities": ["read", "write"],
        "compatibility": "Validated on DuckDB 2.0.0 with its matching postgres extension, PostgreSQL 16, Linux x86_64. Other versions require validation.",
    },
    "oracle": {
        "id": "oracle",
        "name": "Oracle · OraDuck",
        "family": "database",
        "description": "Read Oracle tables and load existing tables through OraDuck.",
        "parameters": [
            {"name": "user", "type": "text"},
            {"name": "password", "type": "text", "secret": True},
            {"name": "dsn", "type": "text"},
        ],
        "extensions": [{"name": "oraduck", "repository": "community"}],
        "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE oraduck, USER {{ user }}, PASSWORD {{ password }}, DSN {{ dsn }}); ATTACH '' AS {{ alias }} (TYPE oraduck, SECRET {{ secret_name }});",
        "capabilities": ["read", "write"],
        "compatibility": "Validated with DuckDB 2.0.0, OraDuck 0.4.0, Oracle 19.3, Instant Client 19.32 on Linux x86_64. Requires a matching extension, Instant Client 19+ (Basic/Basic Light), libaio and libnsl on Linux. Other platforms and versions require validation.",
    },
}
