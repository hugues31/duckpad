"""Write a Windows-1252 CSV inside a managed ZIP without collecting the input table."""

import io
import tempfile
import zipfile
from pathlib import Path

import duckpad as dp


class EncodedZip(dp.Node):
    filename: str = "orders.zip"

    def run(self, orders: dp.Relation) -> None:
        self._orders = orders

    def write(self):
        destination = self.artifact(self.filename)
        with tempfile.TemporaryDirectory(dir=destination.parent) as folder:
            csv = Path(folder) / "orders.csv"
            self._orders.write_csv(str(csv), header=True)
            with (
                csv.open(encoding="utf-8", newline="") as source,
                zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive,
                archive.open("orders.csv", "w") as entry,
                io.TextIOWrapper(entry, encoding="cp1252", errors="strict", newline="") as output,
            ):
                while text := source.read(65536):
                    output.write(text)
        self.message("info", "Encoded export ready")
