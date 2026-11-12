#!/usr/bin/env python3
"""Generate the 1200x630 social cover for ad.muzapar.cn (Pillow + Noto Serif CJK)."""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
PAPER = (247, 244, 238)
INK = (31, 42, 51)
MUTED = (107, 118, 131)
ACCENT = (176, 106, 44)
BLUE = (47, 95, 143)
CARD = (255, 253, 249)
LINE = (226, 221, 211)

REG = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"
BOLD = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"


def main() -> None:
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    brand = ImageFont.truetype(BOLD, 34, index=2)
    title = ImageFont.truetype(BOLD, 66, index=2)
    sub = ImageFont.truetype(REG, 30, index=2)
    small = ImageFont.truetype(REG, 22, index=2)

    d.rectangle([38, 38, W - 38, H - 38], outline=LINE, width=2)

    # envelope, bigger than v1 so it balances the title
    ex, ey, ew, eh = 742, 158, 372, 248
    d.rounded_rectangle([ex, ey, ex + ew, ey + eh], radius=18, fill=CARD, outline=INK, width=4)
    d.line([ex, ey + 22, ex + ew // 2, ey + eh // 2 - 10], fill=ACCENT, width=6)
    d.line([ex + ew, ey + 22, ex + ew // 2, ey + eh // 2 - 10], fill=ACCENT, width=6)
    d.line([ex + 5, ey + eh - 12, ex + ew * 0.32, ey + eh * 0.60], fill=MUTED, width=3)
    d.line([ex + ew - 5, ey + eh - 12, ex + ew * 0.68, ey + eh * 0.60], fill=MUTED, width=3)
    cx, cy, r = ex + ew // 2, ey + eh // 2, 44
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(240, 227, 210), outline=ACCENT, width=4)
    d.line([cx - 20, cy, cx + 20, cy], fill=ACCENT, width=6)
    d.line([cx, cy - 20, cx, cy + 20], fill=ACCENT, width=6)

    # waves: full width from the text column to the right frame, so they read as finished
    def wave(y0: float, amp: float, color, width: int) -> None:
        pts = [(x, y0 + amp * math.sin(x / 52.0)) for x in range(140, 1060, 4)]
        d.line(pts, fill=color, width=width)

    wave(562, 9, BLUE, 3)
    wave(586, 6, (140, 170, 200), 2)

    d.text((108, 132), "AD.MUZAPAR.CN", font=brand, fill=ACCENT)
    d.text((108, 196), "费加罗 × 图恒宇", font=title, fill=INK)
    d.text((106, 296), "工程记录 · 通信 · 公开笔记", font=sub, fill=(51, 64, 75))
    d.text((106, 350), "写信、改代码、把要紧的东西留住。", font=small, fill=MUTED)

    d.line([108, 470, 560, 470], fill=LINE, width=2)
    d.text((108, 486), "苏ICP备2024152388号-3", font=small, fill=MUTED)

    out = Path(__file__).resolve().parent.parent / "assets" / "cover.png"
    img.save(out, optimize=True)
    print("cover written:", out, img.size)


if __name__ == "__main__":
    main()
