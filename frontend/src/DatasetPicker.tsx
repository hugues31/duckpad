import { useT } from "./i18n";
import { type ResultsTarget } from "./results";
import Select from "./Select";

export function DatasetPicker({
  target,
  ports,
  inputs,
  fullNode,
  onSelect,
}: {
  target: ResultsTarget;
  ports: { port: string; count?: number }[];
  inputs: {
    node: string;
    port: string;
    input: string;
    label: string;
    count?: number;
  }[];
  fullNode: string;
  onSelect: (target: ResultsTarget) => void;
}) {
  const t = useT();
  const count = (value?: number) =>
    value === undefined
      ? ""
      : ` · ${value.toLocaleString()} ${t(value === 1 ? "row" : "rows")}`;
  return (
    <Select
      className="dataset-select"
      aria-label={t(ports.length ? "output" : "inputs")}
      title={
        ports.length && inputs.length ? t("inputsToCompareHint") : undefined
      }
      value={target.input ? `input:${target.input}` : target.port}
      onChange={(event) => {
        const value = event.target.value;
        const input = inputs.find((item) => `input:${item.input}` === value);
        onSelect(
          input
            ? { node: input.node, port: input.port, input: input.input }
            : { node: fullNode, port: value },
        );
      }}
    >
      {ports.length > 0 && (
        <optgroup label={t("nodeOutputs")}>
          {ports.map((item) => (
            <option key={item.port} value={item.port}>
              {item.port}
              {count(item.count)}
            </option>
          ))}
        </optgroup>
      )}
      {inputs.length > 0 && (
        <optgroup label={t(ports.length ? "inputsToCompare" : "inputs")}>
          {inputs.map((item) => (
            <option key={item.input} value={`input:${item.input}`}>
              {item.input} ← {item.label} · {item.port}
              {count(item.count)}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
