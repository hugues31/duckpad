"""Lossless JSON documents and one error convention for project declarations."""

import json
from dataclasses import dataclass

from .util import Problem, dumps


@dataclass(frozen=True)
class Document:
    file: str
    description: str

    def read(self, text):
        if text is None:
            return None
        try:
            value = json.loads(text)
        except ValueError:
            return text
        # Keep malformed documents editable, including JSON strings with their quotes.
        return value if isinstance(value, dict) else text

    def write(self, value):
        return value if isinstance(value, str) else dumps(value)

    def declarations(self, value):
        if value is None:
            return {}
        if isinstance(value, str):
            try:
                json.loads(value)
            except ValueError as error:
                raise Problem(f"{self.file} is not valid JSON: {error}", 422) from error
        if not isinstance(value, dict):
            raise Problem(f"{self.file} must contain {self.description}", 422)
        return value

    def problems(self, validate, value):
        try:
            validate(value)
        except Problem as error:
            return [{"file": self.file, "message": str(error)}]
        return []
