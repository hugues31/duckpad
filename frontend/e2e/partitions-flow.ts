import type { Bundle } from "../src/types";

export const partitionFlow: Bundle = {
  flow: {
    partitions: {
      batch: {
        type: "text",
        values: {
          node: "keys",
          column: "batch",
        },
        attributes: ["task"],
      },
    },
    nodes: [
      {
        id: "keys",
        label: "Batches to process",
        template: "keys",
        position: {
          x: 80,
          y: 100,
        },
        params: {},
      },
      {
        id: "source",
        label: "Orders",
        template: "source",
        outputs: {
          result: {
            partition: {
              by: "batch",
              column: "batch",
            },
          },
        },
        position: {
          x: 350,
          y: 100,
        },
        params: {},
      },
      {
        id: "lookup",
        label: "Exchange rate",
        template: "lookup",
        position: {
          x: 620,
          y: 100,
        },
        params: {},
      },
      {
        id: "transform",
        label: "Converted orders",
        template: "transform",
        params: {
          value: "{{ partition.task }}",
        },
        position: {
          x: 80,
          y: 330,
        },
      },
      {
        id: "collect",
        label: "All orders",
        template: "collect",
        partitions: "all",
        position: {
          x: 350,
          y: 330,
        },
        params: {},
      },
    ],
    edges: [
      {
        id: "a",
        source: "source",
        sourceHandle: "result",
        target: "transform",
        targetHandle: "data",
      },
      {
        id: "b",
        source: "lookup",
        sourceHandle: "result",
        target: "transform",
        targetHandle: "lookup",
      },
      {
        id: "c",
        source: "transform",
        sourceHandle: "result",
        target: "collect",
        targetHandle: "data",
      },
    ],
    name: "Partitioned orders",
  },
  templates: {
    keys: "-- @kind source\n-- @output result\nSELECT 'batch-011' AS batch, 'one' AS task UNION ALL SELECT 'batch-012', 'two';",
    source:
      "-- @kind source\n-- @output result\nSELECT * FROM (VALUES ('batch-011', 1), ('batch-011', 1), ('batch-012', 2)) t(batch, amount);",
    lookup: "-- @kind source\n-- @output result\nSELECT 10 AS rate;",
    transform:
      "-- @input data\n-- @input lookup\n-- @param value: expression\n-- @output result\nSELECT d.amount * l.rate AS amount, {{ value }} AS task FROM {{ data }} d CROSS JOIN {{ lookup }} l;",
    collect: "-- @input data\n-- @output result\nSELECT * FROM {{ data }};",
  },
  components: {},
  documentation: {},
};
