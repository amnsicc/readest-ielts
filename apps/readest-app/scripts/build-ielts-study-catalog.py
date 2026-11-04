"""Build the trial study catalog from approved local assets."""
import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

parser = argparse.ArgumentParser()
parser.add_argument("materials", type=Path)
parser.add_argument("assets", type=Path)
parser.add_argument("catalog", type=Path)
args = parser.parse_args()
ns = {"x": "http://www.w3.org/1999/xhtml"}
source = json.loads((args.materials / "selected-targets.json").read_text(encoding="utf-8"))
grades = {"♣": "reading", "♦": "listening", "♥": "speaking", "♠": "writing"}
args.assets.mkdir(parents=True, exist_ok=True)

def copy_asset(relative, name, expected):
    original = args.materials / relative
    data = original.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise ValueError(f"Source digest changed: {relative}")
    if name is not None:
        (args.assets / name).write_bytes(data)
    return data

def sense(row, identity):
    return dict(id=identity, number=row["id"], word=row["word"], meaning=row["meaning"],
                pos=row["pos"], grades={grades[symbol]: int(grade)
                for symbol, grade in re.findall(r"([♣♦♥♠])([012])", row["tags"])})

base = {row["id"]: sense(row, "trial:sense:crust:earth" if row["id"] == "009"
                          else f"trial:sense:{row['id']}") for row in source["readingTargets"]}
senses = list(base.values())
senses += [sense(row, f"trial:sense:supplement:{row['id']}") for row in source["selectedSupplement"]]
for row, identity in zip(source["senseDistinction"], ("bread", "pastry", "earth", "hard-layer"), strict=True):
    if identity != "earth":
        senses.append(sense(dict(id="009", word="crust", meaning=row["sense"], pos="n.", tags=row["tags"]),
                            f"trial:sense:crust:{identity}"))

reading = []
for label, folder, digest in (
    ("A", "A-v1", "309f5e4a76ace7f32b8c68d3f743f380411ffb171e31048467cf54d87bc93cdc"),
    ("B", "B-new", "6a618dd7d9309c94d3dd649fd7913887ce82283b1b5a8d1f9d37bb8197f239c9"),
):
    name = f"reading-{label}.epub"
    copy_asset(f"{folder}/{name}", name, digest)
    with ZipFile(args.assets / name) as epub:
        doc = ET.fromstring(epub.read("OEBPS/article.xhtml"))
    locations = []
    for paragraph in doc.findall(".//x:p", ns):
        if not paragraph.get("id"):
            continue
        for previous, following in zip(list(paragraph), list(paragraph)[1:]):
            anchor = following.get("href", "")
            if not re.fullmatch(r"#g\d{3}", anchor):
                continue
            row = base[anchor[2:]]
            actual = "".join(previous.itertext())
            if actual.casefold() != row["word"].casefold():
                raise ValueError(f"Target mismatch at {label}/{paragraph.get('id')}/{anchor}")
            locations.append(dict(paragraph=paragraph.get("id"), anchor=anchor, actual=actual, senseId=row["id"]))
    if {item["senseId"] for item in locations} != {row["id"] for row in base.values()}:
        raise ValueError(f"Unexpected occurrence inventory for {label}")
    reading.append(dict(id=f"trial:reading:001-020:{label}", version=f"trial:reading:001-020:{label}:v1",
                        label=label, file=name, sha256=digest,
                        section="OEBPS/article.xhtml", locations=locations))

copy_asset("listening-round-01-001-010.mp3", "listening.mp3",
           "128a967e08c895829efc24d5c1112d38b40585ce28e6ba2dc2f34ce25b4accee")
transcript = copy_asset("listening-round-01-001-010.txt", None,
                        "1644f9d683f0b92eb17a07d5c3dab391c6587dc9e753816557a3f7d4668962e2")
args.catalog.parent.mkdir(parents=True, exist_ok=True)
args.catalog.write_text(json.dumps(dict(senses=senses, reading=reading,
                                       transcript=transcript.decode("utf-8")), ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
