"""Real NISAR inputs for Ground Deformation, Glacier Movement and Forest filters.

    deformation : NISAR L2 GUNW unwrapped interferograms -> line-of-sight (LOS) displacement per pair
    glacier     : NISAR L2 GOFF pixel offsets            -> surface speed (m/day) + uncertainty per pair
    forest      : NISAR L2 GCOV HV backscatter           -> cross-pol backscatter (dB) per pass

Each run reads ONLY the area-of-interest window of each product (authenticated HTTP range reads),
aggregates to the app's Web-Mercator grid, and writes:
    public/data/nisar-<kind>/<aoi>/manifest.json
    public/data/nisar-<kind>/<aoi>/<frame>.<layer>.bin    (little-endian, see manifest "layers")

Usage:
    server/.venv/Scripts/python server/nisar_prep.py deformation --start 2025-11-01 --end 2026-11-14
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np
import requests
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).parent))
import flood_prep as fp  # noqa: E402  (grid, search helpers, env, logging, GCOV reader)
from httpfile import HttpRangeFile, earthdata_token  # noqa: E402

ROOT = fp.ROOT
CACHE = fp.CACHE
log = fp.log

AOIS = {
    # San Joaquin Valley, California: well-documented groundwater-driven land subsidence.
    "sjv": dict(name="San Joaquin Valley (Tulare basin), California (USA)", z=9, x0=85, y0=200, tiles_x=3, tiles_y=3, cells_per_tile=128,
                focus=(-119.55, 36.05)),  # Corcoran subsidence bowl
    # Malaspina and Hubbard glaciers, Yakutat, Alaska.
    "yakutat": dict(name="Malaspina & Hubbard glaciers, Alaska (USA)", z=9, x0=56, y0=147, tiles_x=3, tiles_y=3, cells_per_tile=128,
                    focus=(-140.3, 60.05)),  # Malaspina / Seward ice
    # Oregon Coast Range: intensively managed (harvested) forest next to the Willamette Valley.
    "oregon": dict(name="Oregon Coast Range forests (USA)", z=9, x0=79, y0=184, tiles_x=3, tiles_y=3, cells_per_tile=128,
                   focus=(-123.6, 44.6)),
}
KINDS = {
    "deformation": dict(aoi="sjv", product="GUNW"),
    "glacier": dict(aoi="yakutat", product="GOFF"),
    "forest": dict(aoi="oregon", product="GCOV"),
}
NODATA_I16 = -32768
NODATA_U16 = 65535
C = 299_792_458.0


def search(product: str, grid: fp.Grid, start: str, end: str) -> list[dict]:
    out = {}
    for short, status in [(f"NISAR_L2_{product}_V1", "Validated"), (f"NISAR_L2_{product}_PROVISIONAL_V1", "Provisional")]:
        page = 1
        while True:
            r = requests.get(fp.CMR, params={
                "short_name": short, "bounding_box": f"{grid.west},{grid.south},{grid.east},{grid.north}",
                "temporal": f"{start}T00:00:00Z,{end}T23:59:59Z", "page_size": 200, "page_num": page, "sort_key": "start_date",
            }, timeout=60)
            r.raise_for_status()
            entries = r.json()["feed"]["entry"]
            for e in entries:
                h5 = next((l["href"] for l in e["links"] if l["href"].startswith("https") and l["href"].endswith(".h5") and "/NISAR/" in l["href"]), None)
                if not h5:
                    continue
                track, direction, frame = fp.parse_track(e["title"])
                key = (track, direction, frame, e["time_start"][:16], (e.get("time_end") or "")[:16])
                g = dict(title=e["title"], url=h5, start=e["time_start"], end=e.get("time_end") or e["time_start"],
                         status=status, track=track, direction=direction, frame=frame)
                if key not in out or (out[key]["status"] == "Provisional" and status == "Validated"):
                    out[key] = g
            if len(entries) < 200:
                break
            page += 1
    return sorted(out.values(), key=lambda g: g["start"])


def aoi_window(xs, ys, epsg: int, grid: fp.Grid):
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
    lons = np.concatenate([np.linspace(grid.west, grid.east, 50)] * 2 + [np.full(50, grid.west), np.full(50, grid.east)])
    lats = np.concatenate([np.full(50, grid.north), np.full(50, grid.south), np.linspace(grid.south, grid.north, 50), np.linspace(grid.south, grid.north, 50)])
    ux, uy = to_utm.transform(lons, lats)
    dx, dy = xs[1] - xs[0], ys[1] - ys[0]
    c0 = int(np.clip(np.floor((ux.min() - xs[0]) / dx), 0, len(xs)))
    c1 = int(np.clip(np.ceil((ux.max() - xs[0]) / dx) + 1, 0, len(xs)))
    r0 = int(np.clip(np.floor((uy.max() - ys[0]) / dy), 0, len(ys)))
    r1 = int(np.clip(np.ceil((uy.min() - ys[0]) / dy) + 1, 0, len(ys)))
    return r0, r1, c0, c1


def cell_index_for(xs, ys, epsg, grid, r0, r1, c0, c1):
    to_ll = Transformer.from_crs(epsg, 4326, always_xy=True)
    X, Y = np.meshgrid(xs[c0:c1], ys[r0:r1])
    lon, lat = to_ll.transform(X, Y)
    return grid.cell_index(lat, lon).ravel()


def cell_median(idx: np.ndarray, values: np.ndarray, n: int, min_count: int) -> tuple[np.ndarray, np.ndarray]:
    """Per-cell median of values (NaN where fewer than min_count samples)."""
    order = np.argsort(idx, kind="stable")
    si, sv = idx[order], values[order]
    out = np.full(n, np.nan)
    cnt = np.bincount(si, minlength=n)
    starts = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    for c in np.nonzero(cnt >= min_count)[0]:
        out[c] = np.median(sv[starts[c]:starts[c] + cnt[c]])
    return out, cnt


# ---------------------------------------------------------------- deformation (GUNW)
def read_gunw(g: dict, grid: fp.Grid, token: str) -> dict:
    cpath = CACHE / f"{g['title']}_def.npz"
    if cpath.exists():
        d = np.load(cpath)
        return {k: d[k] for k in d.files}
    n = grid.rows * grid.cols
    f = HttpRangeFile(g["url"], token)
    with h5py.File(f, "r") as h:
        base = h["science/LSAR/GUNW/grids/frequencyA"]
        wl = C / float(base["centerFrequency"][()])
        ui = base["unwrappedInterferogram"]
        hh = ui["HH"]
        epsg = int(ui["projection"].attrs["epsg_code"])
        xs, ys = ui["xCoordinates"][()], ui["yCoordinates"][()]
        r0, r1, c0, c1 = aoi_window(xs, ys, epsg, grid)
        empty = dict(disp_mm=np.full(n, np.nan), coh=np.full(n, np.nan), wavelength=np.array([wl]), iono=np.array([0]))
        if r1 - r0 < 2 or c1 - c0 < 2:
            np.savez_compressed(cpath, **empty)
            return empty
        phase = hh["unwrappedPhase"][r0:r1, c0:c1]
        coh = hh["coherenceMagnitude"][r0:r1, c0:c1]
        cc = hh["connectedComponents"][r0:r1, c0:c1]
        iono_ok = "ionospherePhaseScreen" in hh
        iono = hh["ionospherePhaseScreen"][r0:r1, c0:c1] if iono_ok else None
    idx = cell_index_for(xs, ys, epsg, grid, r0, r1, c0, c1)
    ph = phase.ravel().astype(np.float64)
    if iono is not None:
        ph = ph - np.nan_to_num(iono.ravel().astype(np.float64), nan=0.0)
    # Positive = motion toward the satellite (LOS shortening), per the -λ/4π convention.
    disp = -ph * wl / (4 * np.pi) * 1000.0
    ok = (idx >= 0) & np.isfinite(disp) & (cc.ravel() > 0) & (coh.ravel() >= 0.3)
    dmed, _ = cell_median(idx[ok], disp[ok], n, 8)
    cmean = np.full(n, np.nan)
    cc_cnt = np.bincount(idx[idx >= 0], weights=np.nan_to_num(coh.ravel()[idx >= 0]), minlength=n)
    tot = np.bincount(idx[idx >= 0], minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        cmean = np.where(tot > 0, cc_cnt / tot, np.nan)
    res = dict(disp_mm=dmed, coh=cmean, wavelength=np.array([wl]), iono=np.array([1 if iono is not None else 0]))
    log(f"  read {g['title'][17:62]}… {f.bytes_fetched / 1e6:.0f} MB")
    np.savez_compressed(cpath, **res)
    return res


# ---------------------------------------------------------------- glacier (GOFF)
def read_goff(g: dict, grid: fp.Grid, token: str) -> dict:
    cpath = CACHE / f"{g['title']}_ice.npz"
    if cpath.exists():
        d = np.load(cpath)
        return {k: d[k] for k in d.files}
    n = grid.rows * grid.cols
    f = HttpRangeFile(g["url"], token)
    with h5py.File(f, "r") as h:
        po = h["science/LSAR/GOFF/grids/frequencyA/pixelOffsets"]
        epsg = int(po["projection"].attrs["epsg_code"])
        xs, ys = po["xCoordinates"][()], po["yCoordinates"][()]
        r0, r1, c0, c1 = aoi_window(xs, ys, epsg, grid)
        empty = dict(speed=np.full(n, np.nan), sigma=np.full(n, np.nan), incidence=np.array([np.nan]))
        if r1 - r0 < 2 or c1 - c0 < 2:
            np.savez_compressed(cpath, **empty)
            return empty
        layers = []
        for name in ("layer1", "layer2", "layer3"):
            L = po["HH"][name]
            layers.append(dict(
                at=L["alongTrackOffset"][r0:r1, c0:c1], sr=L["slantRangeOffset"][r0:r1, c0:c1],
                vat=L["alongTrackOffsetVariance"][r0:r1, c0:c1], vsr=L["slantRangeOffsetVariance"][r0:r1, c0:c1],
                snr=L["snr"][r0:r1, c0:c1],
            ))
        inc_deg = np.nan
        try:  # incidence angle from the radar-grid metadata cube (middle height, scene centre)
            ia = h["science/LSAR/GOFF/metadata/radarGrid/incidenceAngle"][()]
            inc_deg = float(np.nanmedian(ia[ia.shape[0] // 2]))
        except Exception:
            pass
    inc = inc_deg if np.isfinite(inc_deg) else 40.0
    sin_i = math.sin(math.radians(inc))
    snr = np.stack([L["snr"] for L in layers])
    best = np.argmax(np.nan_to_num(snr, nan=-1), axis=0)  # per pixel, the layer with the best SNR
    pick = lambda k: np.take_along_axis(np.stack([L[k] for L in layers]), best[None], 0)[0]  # noqa: E731
    at, sr, vat, vsr, s = pick("at"), pick("sr"), pick("vat"), pick("vsr"), pick("snr")
    dt_days = (datetime.fromisoformat(g["end"].replace("Z", "+00:00")) - datetime.fromisoformat(g["start"].replace("Z", "+00:00"))).total_seconds() / 86400
    dt_days = max(round(dt_days), 1)
    gr = sr / sin_i  # slant range -> ground range offset
    speed = np.sqrt(at.astype(np.float64) ** 2 + gr ** 2) / dt_days
    sigma = np.sqrt(np.abs(vat) + np.abs(vsr) / sin_i ** 2) / dt_days
    idx = cell_index_for(xs, ys, epsg, grid, r0, r1, c0, c1)
    ok = (idx >= 0) & np.isfinite(speed.ravel()) & (s.ravel() >= 5)
    smed, _ = cell_median(idx[ok], speed.ravel()[ok], n, 3)
    umed, _ = cell_median(idx[ok], sigma.ravel()[ok], n, 3)
    res = dict(speed=smed, sigma=umed, incidence=np.array([inc_deg]), dt=np.array([dt_days]))
    log(f"  read {g['title'][17:62]}… {f.bytes_fetched / 1e6:.0f} MB (incidence {inc_deg:.1f}°)")
    np.savez_compressed(cpath, **res)
    return res


# ---------------------------------------------------------------- forest (GCOV HV)
def forest_from_gcov(frames: list[dict], n: int) -> np.ndarray:
    """Per-cell mean HV backscatter (dB, power-averaged) for one pass; NaN where too few samples."""
    pw = np.zeros(n)
    cnt = np.zeros(n)
    for f in frames:
        if not len(f["idx"]):
            continue
        lin = 10 ** (f["hv"].astype(np.float64) / 10)
        c = np.bincount(f["idx"], minlength=n)
        s = np.bincount(f["idx"], weights=lin, minlength=n)
        take = c > cnt  # per cell, the frame with most samples
        pw[take] = s[take] / c[take]
        cnt = np.maximum(cnt, c)
    with np.errstate(divide="ignore", invalid="ignore"):
        db = np.where(cnt >= 15, 10 * np.log10(pw), np.nan)
    return db


# ---------------------------------------------------------------- main
def to_i16(a: np.ndarray, scale: float) -> bytes:
    v = np.where(np.isfinite(a), np.clip(np.round(a * scale), -32767, 32767), NODATA_I16).astype("<i2")
    return v.tobytes()


def to_u16(a: np.ndarray, scale: float) -> bytes:
    v = np.where(np.isfinite(a), np.clip(np.round(a * scale), 0, 65534), NODATA_U16).astype("<u2")
    return v.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=list(KINDS))
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tracks", type=int, default=2, help="Keep the N tracks with most coverage (interferometric kinds)")
    ap.add_argument("--min-valid", type=float, default=0.15, help="Minimum fraction of the AOI with valid values to keep a frame")
    args = ap.parse_args()
    fp.load_env()
    token = earthdata_token()
    kind = KINDS[args.kind]
    a = AOIS[kind["aoi"]]
    grid = fp.Grid(a)
    n = grid.rows * grid.cols
    out_dir = ROOT / "public" / "data" / f"nisar-{args.kind}" / kind["aoi"]
    out_dir.mkdir(parents=True, exist_ok=True)

    log(f"Searching NISAR {kind['product']} {args.start} → {args.end} over {a['name']}…")
    granules = search(kind["product"], grid, args.start, args.end)
    log(f"{len(granules)} granules")
    if args.kind in ("deformation", "glacier"):
        # Keep the tracks (direction + track) that most often image the area's focus point.
        from collections import Counter
        fx, fy = a["focus"]
        hits = Counter()
        for short in (f"NISAR_L2_{kind['product']}_V1", f"NISAR_L2_{kind['product']}_PROVISIONAL_V1"):
            r = requests.get(fp.CMR, params={"short_name": short, "point": f"{fx},{fy}", "temporal": f"{args.start}T00:00:00Z,{args.end}T23:59:59Z",
                                             "page_size": 200}, timeout=60)
            for e in r.json()["feed"]["entry"]:
                t, d, _ = fp.parse_track(e["title"])
                hits[(t, d)] += 1
        keep = {k for k, _ in hits.most_common(args.max_tracks)}
        granules = [g for g in granules if (g["track"], g["direction"]) in keep]
        log(f"Keeping tracks {sorted(keep)}: {len(granules)} granules")

    reader = {"deformation": read_gunw, "glacier": read_goff, "forest": fp.read_granule}[args.kind]
    results: dict[str, dict] = {}
    with cf.ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(reader, g, grid, token): g for g in granules}
        for fut in cf.as_completed(futs):
            g = futs[fut]
            try:
                results[g["title"]] = fut.result()
            except Exception as e:
                log(f"  failed (will retry) {g['title'][:70]}: {e}")
    for g in granules:
        if g["title"] not in results:
            try:
                results[g["title"]] = reader(g, grid, token)
            except Exception as e:
                log(f"  FAILED {g['title'][:70]}: {e}")

    # Group frames of the same acquisition (pair) and mosaic per cell (first valid value).
    groups: dict[tuple, list[dict]] = {}
    for g in granules:
        if g["title"] in results:
            groups.setdefault((g["track"], g["direction"], g["start"][:10], g["end"][:10]), []).append(g)

    frames_meta = []
    for (track, direction, d0, d1), gs in sorted(groups.items(), key=lambda kv: kv[1][0]["start"]):
        rs = [results[g["title"]] for g in gs]
        fid = f"{d0}_{d1}_T{track:03d}{direction}" if args.kind != "forest" else f"{d0}_T{track:03d}{direction}"
        meta = dict(
            id=fid,
            start=min(g["start"] for g in gs),
            end=max(g["end"] for g in gs),
            track=track,
            direction="Ascending" if direction == "A" else "Descending",
            status="Validated" if all(g["status"] == "Validated" for g in gs) else "Provisional",
            granules=[g["title"] for g in gs],
        )
        if args.kind == "deformation":
            disp = np.full(n, np.nan)
            coh = np.full(n, np.nan)
            for r in rs:
                m = np.isnan(disp) & np.isfinite(r["disp_mm"])
                disp[m] = r["disp_mm"][m]
                m2 = np.isnan(coh) & np.isfinite(r["coh"])
                coh[m2] = r["coh"][m2]
            valid = np.isfinite(disp)
            if valid.mean() < args.min_valid:
                log(f"  skip {fid}: valid {valid.mean():.0%}")
                continue
            ref = float(np.median(disp[valid]))  # referenced to the scene median (relative motion)
            disp = disp - ref
            meta.update(validFraction=round(float(valid.mean()), 4), medianCoherence=round(float(np.nanmedian(coh)), 3),
                        referenceOffsetMm=round(ref, 2), ionosphereCorrected=bool(all(int(r["iono"][0]) for r in rs)),
                        wavelengthM=round(float(rs[0]["wavelength"][0]), 4), p95AbsMm=round(float(np.percentile(np.abs(disp[valid]), 95)), 1))
            (out_dir / f"{fid}.disp.bin").write_bytes(to_i16(disp, 10))     # 0.1 mm units
            (out_dir / f"{fid}.coh.bin").write_bytes(to_u16(coh, 1000))     # coherence × 1000
        elif args.kind == "glacier":
            sp = np.full(n, np.nan)
            sg = np.full(n, np.nan)
            for r in rs:
                m = np.isnan(sp) & np.isfinite(r["speed"])
                sp[m] = r["speed"][m]
                sg[m] = r["sigma"][m]
            valid = np.isfinite(sp)
            if valid.mean() < args.min_valid:
                log(f"  skip {fid}: valid {valid.mean():.0%}")
                continue
            meta.update(validFraction=round(float(valid.mean()), 4), temporalBaselineDays=int(rs[0].get("dt", np.array([12]))[0]),
                        incidenceDeg=round(float(np.nanmean([r["incidence"][0] for r in rs])), 1),
                        p99SpeedMPerDay=round(float(np.percentile(sp[valid], 99)), 2), medianSigmaMPerDay=round(float(np.nanmedian(sg)), 3))
            (out_dir / f"{fid}.speed.bin").write_bytes(to_u16(sp, 100))    # cm/day
            (out_dir / f"{fid}.sigma.bin").write_bytes(to_u16(sg, 100))    # cm/day
        else:
            hv = forest_from_gcov(rs, n)
            valid = np.isfinite(hv)
            if valid.mean() < args.min_valid:
                log(f"  skip {fid}: valid {valid.mean():.0%}")
                continue
            meta.update(validFraction=round(float(valid.mean()), 4), medianHvDb=round(float(np.nanmedian(hv)), 2))
            (out_dir / f"{fid}.hv.bin").write_bytes(to_i16(hv, 100))       # dB × 100
        frames_meta.append(meta)
        log(f"  {fid}: " + ", ".join(f"{k}={v}" for k, v in meta.items() if k not in ("granules", "id", "start", "end")))

    layers = {
        "deformation": {"disp": dict(dtype="int16", scale=0.1, unit="mm", nodata=NODATA_I16, description="LOS displacement, + toward satellite, relative to scene median"),
                        "coh": dict(dtype="uint16", scale=0.001, unit="", nodata=NODATA_U16, description="mean interferometric coherence")},
        "glacier": {"speed": dict(dtype="uint16", scale=0.01, unit="m/day", nodata=NODATA_U16, description="horizontal surface speed (offset tracking)"),
                    "sigma": dict(dtype="uint16", scale=0.01, unit="m/day", nodata=NODATA_U16, description="1-sigma speed uncertainty from offset variances")},
        "forest": {"hv": dict(dtype="int16", scale=0.01, unit="dB", nodata=NODATA_I16, description="HV (cross-pol) backscatter, terrain-corrected gamma0")},
    }[args.kind]
    method = {
        "deformation": "Per pair: unwrapped HH phase minus the product's ionospheric phase screen, converted to LOS displacement with -λ/4π "
                       "(positive = toward the satellite). Samples with coherence < 0.3 or connected component 0 are dropped; per-cell median of "
                       "80 m samples (≥ 8). Each pair is referenced to its scene median, so values are relative motion within the area.",
        "glacier": "Per pair: along-track and slant-range pixel offsets (per sample, the offset layer with highest SNR; SNR ≥ 5), slant range "
                   "projected to ground range with the scene-centre incidence angle, divided by the temporal baseline. Per-cell median of "
                   "samples; uncertainty from the product's offset variances.",
        "forest": "Per pass: power-averaged HV (cross-polarised) terrain-corrected backscatter of valid 80 m samples per cell (≥ 15 samples), in dB. "
                  "Change is only meaningful between passes of the same track (same viewing geometry).",
    }[args.kind]
    limitations = {
        "deformation": "Single 12-day pairs are dominated by tropospheric noise (often ±1–2 cm); slow subsidence is clearer when pairs on one track are "
                       "summed. Unwrapping errors can occur across low-coherence areas. Values are line-of-sight, not vertical.",
        "glacier": "Offset tracking fails on featureless snow and where surface change between passes is large; slow ice (< ~0.1 m/day) is within noise. "
                   "Scene-centre incidence is used for the ground-range projection.",
        "forest": "HV also responds to soil and vegetation moisture, freeze/thaw and terrain; a drop is a possible disturbance (harvest, fire, storm), "
                  "not a confirmed one. Not calibrated to biomass in this app.",
    }[args.kind]
    manifest = dict(kind=args.kind, aoi=kind["aoi"], name=a["name"], product=f"NISAR L2 {kind['product']}",
                    grid=dict(z=a["z"], x0=a["x0"], y0=a["y0"], tilesX=a["tiles_x"], tilesY=a["tiles_y"], cellsPerTile=a["cells_per_tile"]),
                    generated=datetime.now(timezone.utc).isoformat(timespec="seconds"), range=dict(start=args.start, end=args.end),
                    layers=layers, method=method, limitations=limitations, frames=frames_meta)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    log(f"Wrote {len(frames_meta)} frames → {out_dir}")


if __name__ == "__main__":
    main()
