# Real NISAR flood data (offline prep)

The Flood filter's **Real NISAR** mode is built from actual NISAR L2 GCOV radar products.
This folder holds the script that turns them into small water maps the web app loads.

## One-time setup

```bash
python -m venv server/.venv
server/.venv/Scripts/python -m pip install h5py numpy requests pyproj pillow
```

Put your Earthdata token in `.env.local` at the repo root. It's git-ignored and only read
by this script, never shipped to the browser:

```
EARTHDATA_TOKEN=...
```

Generate a token at https://urs.earthdata.nasa.gov → *Generate Token*. Tokens expire after
about 60 days; rotate yours if it is ever shared.

## Run

```bash
npm run prep:flood -- --start 2026-06-01 --end 2026-11-14
```

The script:
1. Finds NISAR GCOV products over the area in NASA CMR, preferring validated over provisional.
2. Reads **only the area's window** of the 80 m HH/HV backscatter, about 50–75 MB per product
   instead of ~9 GB, using authenticated HTTP range requests.
3. Classifies each 80 m sample as water when it is radar-dark. Thresholds are trained per pass
   against JRC persistent-water and never-water reference cells.
4. Writes `public/data/nisar-flood/<aoi>/manifest.json` and one `<pass>.bin` per pass
   (one byte per grid cell: 0 no data, 1 dry, 2 water).

Downloads are cached in `server/cache/` (git-ignored), so reruns are fast.

## Limitations

- Flooded vegetation can look **bright** (double bounce) and be missed.
- Wind-roughened water can be missed; radar shadow and very smooth surfaces can look like water.
- Each pass images only part of the area. The app compares passes only over area imaged by both.
- Not validated against ground truth.
