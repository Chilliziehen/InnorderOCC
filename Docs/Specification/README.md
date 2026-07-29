# Innorder OCC Specification Deliverables

This directory contains the bilingual software specification and database design generated from the project proposal, architecture document, database design, executable migrations, and database tests.

## Primary deliverables

- `Innorder_OCC_Specification_zh.tex` and `.pdf`: complete Chinese specification.
- `Innorder_OCC_Specification_en.tex` and `.pdf`: complete English specification.
- `diagrams/*.puml`: maintainable PlantUML sources.
- `diagrams/*.svg`: vector diagram deliverables.
- `diagrams/*.pdf`: vector copies embedded by LaTeX.

## Diagram inventory

1. System context
2. Container architecture
3. OCC Core module boundaries
4. Domain model
5. Authorization-sensitive command sequence
6. Evidence upload and review sequence
7. Private deployment topology
8. PostgreSQL schema responsibility map
9. Core database ERD
10. AI and RAG database ERD

## Rebuild

From this directory's repository root on Windows PowerShell:

```powershell
$env:GRAPHVIZ_DOT = 'C:\Program Files\Graphviz\bin\dot.exe'
Get-ChildItem Docs\Specification\diagrams\*.puml | ForEach-Object {
  java -jar Docs\Specification\tools\plantuml.jar -tsvg $_.FullName
}

Get-ChildItem Docs\Specification\diagrams\*.svg | ForEach-Object {
  & 'C:\Program Files\Inkscape\bin\inkscape.exe' $_.FullName `
    --export-type=pdf `
    --export-filename=([System.IO.Path]::ChangeExtension($_.FullName, '.pdf'))
}

latexmk -xelatex -interaction=nonstopmode -halt-on-error `
  -output-directory=Docs\Specification\build-zh `
  Docs\Specification\Innorder_OCC_Specification_zh.tex

latexmk -xelatex -interaction=nonstopmode -halt-on-error `
  -output-directory=Docs\Specification\build-en `
  Docs\Specification\Innorder_OCC_Specification_en.tex
```

PlantUML 1.2025.4 is retained under `tools/` for reproducibility. Graphviz and Inkscape are external system dependencies.
