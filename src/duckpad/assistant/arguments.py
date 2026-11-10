"""Operation-specific tool arguments: each operation accepts only its own fields."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator


class VariableChange(BaseModel):
    """One variable operation; arguments of other operations are rejected."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def omit_nulls(cls, data):
        # Some providers send null for every optional parameter: null means omitted.
        return {k: v for k, v in data.items() if v is not None} if isinstance(data, dict) else data


class CreateVariable(VariableChange):
    """Declare a new variable."""

    operation: Literal["create"]
    definition: dict[str, JsonValue] = Field(min_length=1)


class UpdateVariable(VariableChange):
    """Merge definition fields and environments; removals happen first."""

    operation: Literal["update"]
    definition: dict[str, JsonValue] | None = None
    remove_fields: list[Literal["description", "default", "environments", "from"]] | None = None
    remove_environments: list[str] | None = None

    @model_validator(mode="after")
    def changes_something(self):
        if not (self.definition or self.remove_fields or self.remove_environments):
            raise ValueError("Provide definition, remove_fields or remove_environments")
        return self


class RenameVariable(VariableChange):
    """Rename a variable and update its references."""

    operation: Literal["rename"]
    new_name: str = Field(min_length=1)


class DeleteVariable(VariableChange):
    """Delete a variable that nothing uses."""

    operation: Literal["delete"]
