# Duckpad, Dataiku and Alteryx

Already familiar with Dataiku DSS or Alteryx Designer? Use this vocabulary map
to find your bearings in Duckpad. These are the closest concepts; behavior and
feature coverage differ.

| Duckpad | Dataiku DSS | Alteryx Designer |
| --- | --- | --- |
| [Flow / pipeline](WORKSPACE.md) | Flow | Workflow |
| [Transformation node](SQL.md) | Recipe | Tool |
| [Output table](RESULTS.md) | Dataset | Data stream at an output anchor |
| [Input / output port](SQL.md#declarations) | Recipe input / output dataset | Input / output anchor |
| [Load CSV / Load table](CONNECTORS.md) | Input dataset | Input Data tool |
| [Export node](SQL.md#write-an-export) | Sync recipe + output dataset | Output Data tool |
| [Select columns](DATA_PREPARATION.md) | Prepare recipe: column steps | Select tool |
| [Clean values](DATA_PREPARATION.md) | Prepare recipe: cleaning steps | Data Cleansing tool; DateTime for date parsing |
| Filter | Prepare recipe: filter rows | Filter tool |
| Join | Join recipe | Join tool |
| Aggregate | Group recipe | Summarize tool |
| [Component](COMPONENTS.md) | [Application-as-recipe](https://doc.dataiku.com/dss/latest/applications/application-as-recipe.html) | [Standard macro](https://help.alteryx.com/designer/current/en/apps-and-macros/macros.html) |
| [Project variable](VARIABLES.md) | [Project variable](https://doc.dataiku.com/dss/latest/scenarios/variables.html#variables-scope) | [User constant](https://help.alteryx.com/designer/current/en/tools/preparation/formula-tool/constants.html) |
| [Results panel](RESULTS.md) | Dataset Explore tab | Results window / Browse tool |

Duckpad exposes tables on node outputs; Dataiku shows datasets as separate Flow
objects. Duckpad components package reusable sub-flows; Dataiku's
[Flow zones](https://doc.dataiku.com/dss/latest/flow/zones.html) only organize them.

Reference terminology: Dataiku [Flow](https://doc.dataiku.com/dss/latest/flow/index.html)
and [visual recipes](https://doc.dataiku.com/dss/latest/visual-recipes/index.html);
Alteryx [interface](https://help.alteryx.com/current/en/designer/get-started/designer-user-interface.html)
and [tools](https://help.alteryx.com/designer/current/en/tools/designer-tools-list.html).

Continue with [Duckpad in 15 minutes](QUICKSTART.md).
