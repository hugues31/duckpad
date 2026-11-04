# Document a project

Write the project overview in **Documentation**. It edits `README.md`, also
available in **Code**. Documentation is versioned with the project.

![Business documentation for Paid orders alongside its result table](images/node-documentation.png)

Describe a node in the inspector's **Documentation** tab. Edit output and column
descriptions in **Results → Columns**, alongside the schema. These descriptions
live in `documentation.json`; component imports carry them to the destination.

A confirmed schema removal deletes the missing column's description in a
versioned save. Renamed columns start undocumented. Invalid SQL, failed runs
and backend restarts do not delete descriptions. Earlier versions remain in
[Git history](GIT.md).
