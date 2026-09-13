# _grab.py — 自适应抓取向导指定页面(仅供 NSIS 向导联调)
# 思路: Electron 冷启动要 2~3s, 期间向导可能被外部输入推走; 改用 Python+PrintWindow
# (启动 <0.3s) 轮询: 目标控件出现就立即抓图, 否则前进一步再试。
# 用法: python _grab.py <expectCtrlId> <out.bmp> [btnId]
import ctypes
import sys
import time
from ctypes import wintypes

u = ctypes.windll.user32
g = ctypes.windll.gdi32

WND_CLASS = "#32770"
WND_TITLE = "Fntv-Plus 安装 "
BM_CLICK = 0x00F5
GWL_STYLE = -16


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]


def main_window():
    return u.FindWindowW(WND_CLASS, WND_TITLE)


def find_by_id(hwnd, want):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _):
        if u.GetDlgCtrlID(child) == want:
            found.append(child)
            return False
        return True

    u.EnumChildWindows(hwnd, cb, 0)
    return found[0] if found else 0


def capture_bmp(hwnd, out):
    r = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(hwnd)
    mdc = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, w, h)
    g.SelectObject(mdc, bmp)
    u.PrintWindow(hwnd, mdc, 2)                      # PW_RENDERFULLCONTENT

    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h                       # 负数 = top-down
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0                   # BI_RGB
    buf = ctypes.create_string_buffer(w * h * 4)
    g.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)

    # 32bpp BGRA → 24bpp BGR bottom-up BMP
    stride = (w * 3 + 3) & ~3
    data = bytearray(stride * h)
    for y in range(h):
        src = y * w * 4
        dst = (h - 1 - y) * stride
        for x in range(w):
            s = src + x * 4
            d = dst + x * 3
            data[d] = buf.raw[s]
            data[d + 1] = buf.raw[s + 1]
            data[d + 2] = buf.raw[s + 2]
    hdr = bytearray(54)
    hdr[0:2] = b"BM"
    size = 54 + len(data)
    hdr[2:6] = size.to_bytes(4, "little")
    hdr[10:14] = (54).to_bytes(4, "little")
    hdr[14:18] = (40).to_bytes(4, "little")
    hdr[18:22] = w.to_bytes(4, "little")
    hdr[22:26] = h.to_bytes(4, "little")
    hdr[26:28] = (1).to_bytes(2, "little")
    hdr[28:30] = (24).to_bytes(2, "little")
    hdr[34:38] = len(data).to_bytes(4, "little")
    with open(out, "wb") as f:
        f.write(bytes(hdr))
        f.write(bytes(data))

    g.DeleteObject(bmp)
    g.DeleteDC(mdc)
    u.ReleaseDC(hwnd, hdc)
    return w, h


if __name__ == "__main__":
    want = int(sys.argv[1])
    out = sys.argv[2]
    btn = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    for attempt in range(8):
        hwnd = main_window()
        if not hwnd:
            print("window gone at attempt", attempt)
            sys.exit(1)
        ctl = find_by_id(hwnd, want)
        if ctl:
            vis = bool(u.IsWindowVisible(ctl))
            w, h = capture_bmp(hwnd, out)
            print(f"ctl{want} present(vis={vis}) → {out} {w}x{h} (attempt {attempt})")
            sys.exit(0)
        b = find_by_id(hwnd, btn)
        if not b:
            print(f"btn{btn} not found at attempt {attempt}")
            sys.exit(1)
        u.SendMessageW(b, BM_CLICK, 0, 0)
        time.sleep(0.7)
    print("target not reached")
    sys.exit(1)
