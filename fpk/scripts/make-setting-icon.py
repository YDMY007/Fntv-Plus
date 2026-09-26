# 生成「Fntv-Plus 设置」桌面入口图标（v2，源图 Fntv-Plus-Setting.jpeg）
# 处理：内切裁边 10% + 22% 圆角透明边（与 lc-038 主图标做法一致），输出 256/64 两档
# 产物：app/ui/images/setting_v2_256.png / setting_v2_64.png + docs/setting-icon-v2-preview.png
from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "Fntv-Plus-Setting.jpeg")
OUT_DIR = os.path.join(ROOT, "app", "ui", "images")
DOCS_DIR = os.path.join(ROOT, "docs")

CROP_FRAC = 0.10   # 四边各内切 10%，去掉多余背景留白
RADIUS_FRAC = 0.22 # 圆角半径占边长比例（与 lc-038 一致）

img = Image.open(SRC).convert("RGBA")
w, h = img.size
side = min(w, h)
# 居中取正方形后再内切
cx, cy = w // 2, h // 2
half = side // 2
img = img.crop((cx - half, cy - half, cx + half, cy + half))
side = img.size[0]
m = int(side * CROP_FRAC)
img = img.crop((m, m, side - m, side - m))
side = img.size[0]

# 圆角透明遮罩
mask = Image.new("L", (side, side), 0)
d = ImageDraw.Draw(mask)
r = int(side * RADIUS_FRAC)
d.rounded_rectangle((0, 0, side - 1, side - 1), radius=r, fill=255)
img.putalpha(mask)

os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(DOCS_DIR, exist_ok=True)
for size, name in ((256, "setting_v2_256.png"), (64, "setting_v2_64.png")):
    out = img.resize((size, size), Image.LANCZOS)
    out.save(os.path.join(OUT_DIR, name))
img.resize((512, 512), Image.LANCZOS).save(os.path.join(DOCS_DIR, "setting-icon-v2-preview.png"))

# 简单校验：四角必须全透明
px = img.resize((256, 256), Image.LANCZOS).load()
corners = [px[0, 0][3], px[255, 0][3], px[0, 255][3], px[255, 255][3]]
print("corner alpha:", corners)
print("done: setting_v2_256.png / setting_v2_64.png")
