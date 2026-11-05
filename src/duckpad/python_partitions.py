"""Worker-side partition validation before Python's external write phase."""

import json
import math
import re
from datetime import date, datetime
from decimal import Decimal

from .util import qi


def validate_partitions(db, payload):
    for port, boundary in payload.get("partition_filters", {}).items():
        if port not in payload["outputs"]:
            continue
        entry = payload.get("partition")
        if entry is None:
            raise ValueError("Partition values not calculated; select a key from a resolved manifest")
        column = boundary["column"]
        columns = db.execute("DESCRIBE " + qi(payload["outputs"][port])).fetchall()
        matches = [
            c
            for c in columns
            if c[0].translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
            == column.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        ]
        if len(matches) != 1:
            raise ValueError(f"partition_column: {column} is missing or ambiguous")
        key = entry["key"]
        converted = db.execute(f"SELECT CAST($key AS {matches[0][1]})", {"key": key["value"]}).fetchone()[0]
        sql_type = matches[0][1].upper()
        valid = False
        if key["type"] == "text":
            valid = sql_type == "VARCHAR" and isinstance(converted, str)
        elif key["type"] == "boolean":
            valid = sql_type == "BOOLEAN" and type(converted) is bool
        elif key["type"] == "date":
            valid = sql_type in ("DATE", "VARCHAR")
            if isinstance(converted, date) and not isinstance(converted, datetime):
                converted = converted.isoformat()
        elif key["type"] == "number":
            if isinstance(converted, Decimal):
                decimal = converted
                converted = int(decimal) if decimal == decimal.to_integral_value() else float(decimal)
                valid = math.isfinite(converted) and Decimal(json.dumps(converted)) == decimal
            elif re.fullmatch(r"U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE", sql_type):
                valid = type(converted) in (int, float) and math.isfinite(converted)
            if isinstance(converted, int) and abs(converted) > 2**53 - 1:
                valid = False
        if not valid or converted != key["value"]:
            raise ValueError(f"partition_column: {column} cannot losslessly compare this key")
