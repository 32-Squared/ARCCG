#!/usr/bin/env python3
"""
ARCCG image pipeline — regenerates optimized card images and thumbnails.

Usage:
    python3 tools/build_images.py --src <originals_dir> [--repo <repo_root>]

- Reads pristine card scans from <originals_dir> (###_name.webp, any size/quality)
- Writes optimized play images to  <repo>/cards/###_name.webp
      max-width 400px, WebP quality 70  (~20-40KB each)
- Writes thumbnails to             <repo>/thumbs/###_name.webp
      120x168 (cover-cropped),   WebP quality 70  (~3-6KB each)

Idempotent: safe to re-run. Keep originals out of the repo (git tag / archive).
Requires: pip install pillow
"""
import argparse, os, sys
from pathlib import Path
from PIL import Image

CARD_MAX_W   = 400
CARD_QUALITY = 70
THUMB_SIZE   = (120, 168)
THUMB_QUALITY = 70

def optimize_card(src: Path, dst: Path):
    im = Image.open(src).convert("RGB")
    if im.width > CARD_MAX_W:
        h = round(im.height * CARD_MAX_W / im.width)
        im = im.resize((CARD_MAX_W, h), Image.LANCZOS)
    im.save(dst, "WEBP", quality=CARD_QUALITY, method=6)

def make_thumb(src: Path, dst: Path):
    im = Image.open(src).convert("RGB")
    # cover-crop to thumb aspect, then resize
    tw, th = THUMB_SIZE
    target = tw / th
    ar = im.width / im.height
    if ar > target:   # too wide -> crop sides
        w = round(im.height * target)
        x = (im.width - w) // 2
        im = im.crop((x, 0, x + w, im.height))
    elif ar < target: # too tall -> crop top/bottom
        h = round(im.width / target)
        y = (im.height - h) // 2
        im = im.crop((0, y, im.width, y + h))
    im = im.resize(THUMB_SIZE, Image.LANCZOS)
    im.save(dst, "WEBP", quality=THUMB_QUALITY, method=6)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory of pristine ###_name.webp originals")
    ap.add_argument("--repo", default=".", help="repo root (default: cwd)")
    args = ap.parse_args()

    src_dir  = Path(args.src)
    repo     = Path(args.repo)
    cards_d  = repo / "cards";  cards_d.mkdir(exist_ok=True)
    thumbs_d = repo / "thumbs"; thumbs_d.mkdir(exist_ok=True)

    files = sorted(src_dir.glob("*.webp"))
    if not files:
        sys.exit(f"No .webp files found in {src_dir}")

    total_card = total_thumb = 0
    for f in files:
        card_out  = cards_d  / f.name
        thumb_out = thumbs_d / f.name
        optimize_card(f, card_out)
        make_thumb(f, thumb_out)
        total_card  += card_out.stat().st_size
        total_thumb += thumb_out.stat().st_size
        print(f"  {f.name:40s} card {card_out.stat().st_size//1024:>3}KB  thumb {thumb_out.stat().st_size//1024:>3}KB")

    print(f"\n{len(files)} cards processed")
    print(f"cards/  total: {total_card/1048576:.1f} MB")
    print(f"thumbs/ total: {total_thumb/1048576:.1f} MB")

if __name__ == "__main__":
    main()
