"""Operation-specific tool arguments: each operation accepts only its own fields."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator


class Arguments(BaseModel):
    """Tool arguments that reject unknown fields and treat null as omitted."""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def omit_nulls(cls, data):
        # Some providers send null for every optional parameter: null means omitted.
        return {k: v for k, v in data.items() if v is not None} if isinstance(data, dict) else data


class Change(Arguments):
    """One named operation; arguments of other operations are rejected."""

    name: str = Field(min_length=1)


class VariableChange(Change):
    """One variable operation."""


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


class ChartChange(Change):
    """One chart operation on a node output."""

    node: str = Field(min_length=1, description="Expanded node or component-instance ID shown on the canvas")
    output: str = Field(min_length=1, description="Output port name")


ChartSpec = Annotated[
    dict[str, JsonValue], Field(description="Vega-Lite 6 spec within Duckpad's chart allowlist")
]


class CreateChart(ChartChange):
    """Add a named chart to the output."""

    operation: Literal["create"]
    spec: ChartSpec


class UpdateChart(ChartChange):
    """Replace the whole spec of a chart; nothing is merged."""

    operation: Literal["update"]
    spec: ChartSpec


class RenameChart(ChartChange):
    """Rename a chart on the same output."""

    operation: Literal["rename"]
    new_name: str = Field(min_length=1)


class DeleteChart(ChartChange):
    """Delete a chart; the output leaves charts.json with its last chart."""

    operation: Literal["delete"]
