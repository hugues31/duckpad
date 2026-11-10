"""Operation-specific tool arguments: each operation accepts only its own fields."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, JsonValue, model_validator


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


class Position(Arguments):
    """Canvas coordinates of a node."""

    x: FiniteFloat
    y: FiniteFloat


NodeId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=100)]


class NodeChange(Arguments):
    """Fields shared by adding and updating a node."""

    id: NodeId
    label: str | None = None
    position: Position | None = None
    params: dict[str, JsonValue] | None = None


class AddNode(NodeChange):
    """Add a node with at most one of sql, python, template or component; SELECT 1 by default."""

    operation: Literal["add"]
    template: str | None = None
    component: str | None = None
    sql: str | None = None
    python: str | None = None

    @model_validator(mode="after")
    def one_source(self):
        if sum(bool(v) for v in (self.template, self.component, self.sql, self.python)) > 1:
            raise ValueError("Choose one of sql, python, template or component")
        return self


class UpdateNode(NodeChange):
    """Relabel, move or configure a node; params merges keys, remove_parameters deletes overrides.

    Code and template or component links cannot change here: edit existing code with write_sql.
    """

    operation: Literal["update"]
    remove_parameters: list[str] | None = None

    @model_validator(mode="after")
    def changes_something(self):
        if self.label is None and not (self.position or self.params or self.remove_parameters):
            raise ValueError("Provide label, position, params or remove_parameters")
        return self


class RemoveNode(Arguments):
    """Remove a node, its code and its connections."""

    operation: Literal["remove"]
    id: NodeId


class ConnectEdge(Arguments):
    """Connect an output port of the source node to an input port of the target node."""

    operation: Literal["connect"]
    id: str = Field(min_length=1, max_length=100)
    # Existing nodes keep whatever ID their project gave them; NodeId only limits the IDs of new nodes.
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    source_port: str = "result"
    target_port: str = "input"


class DisconnectEdge(Arguments):
    """Remove a connection."""

    operation: Literal["disconnect"]
    id: str = Field(min_length=1, max_length=100)
