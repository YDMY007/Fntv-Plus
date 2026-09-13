# _wizctl.py — NSIS 向导窗口调试控制(仅供 wizard-test 调试)
# 用法:
#   python _wizctl.py click <btnId>   对(可隐藏)按钮发 BM_CLICK, 不抢焦点
#   python _wizctl.py btn <btnId>     打印按钮样式/位置/可见性
#   python _wizctl.py rect            打印主窗口矩形
#   python _wizctl.py dump            枚举子控件(类名/ID/矩形/可见/文本)
import ctypes
import sys
from ctypes import wintypes

u = ctypes.windll.user32

WND_TITLE = "Fntv-Plus 安装 "
WND_CLASS = "#32770"

BM_CLICK = 0x00F5
GWL_STYLE = -16


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def main_window():
    hwnd = u.FindWindowW(WND_CLASS, WND_TITLE)
    if not hwnd:
        print("main window not found")
        sys.exit(1)
    return hwnd


def text_of(h):
    buf = ctypes.create_unicode_buffer(1024)
    u.GetWindowTextW(h, buf, 1024)
    return buf.value


def class_of(h):
    buf = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, buf, 256)
    return buf.value


def find_by_id(hwnd, want):
    """递归枚举子控件按 ID 查找(页面 dialog 内的控件不在主窗口直系)"""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _):
        if u.GetDlgCtrlID(child) == want:
            found.append(child)
            return False
        return True

    u.EnumChildWindows(hwnd, cb, 0)
    return found[0] if found else 0


def cmd_click(bid):
    hwnd = main_window()
    btn = find_by_id(hwnd, bid)
    if not btn:
        print(f"btn{bid} not found")
        sys.exit(1)
    ok = u.SendMessageW(btn, BM_CLICK, 0, 0)
    print(f"BM_CLICK btn{bid} sent (ret={ok})")


def cmd_btn(bid):
    hwnd = main_window()
    btn = find_by_id(hwnd, bid)
    if not btn:
        print(f"btn{bid} not found")
        sys.exit(1)
    r = RECT()
    u.GetWindowRect(btn, ctypes.byref(r))
    style = u.GetWindowLongW(btn, GWL_STYLE)
    vis = bool(u.IsWindowVisible(btn))
    print(f"btn{bid}: vis={vis} style=0x{style:X} rect=({r.left},{r.top})-({r.right},{r.bottom})")


def cmd_rect():
    hwnd = main_window()
    r = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    print(f"main: ({r.left},{r.top})-({r.right},{r.bottom}) size={r.right-r.left}x{r.bottom-r.top}")


def cmd_dump():
    hwnd = main_window()
    r = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    print(f"main: ({r.left},{r.top})-({r.right},{r.bottom}) size={r.right-r.left}x{r.bottom-r.top}")
    rows = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _):
        cr = RECT()
        u.GetWindowRect(child, ctypes.byref(cr))
        rows.append((u.GetDlgCtrlID(child), class_of(child), bool(u.IsWindowVisible(child)),
                     (cr.left - r.left, cr.top - r.top, cr.right - cr.left, cr.bottom - cr.top),
                     text_of(child), u.GetWindowLongW(child, GWL_STYLE)))
        return True

    u.EnumChildWindows(hwnd, cb, 0)
    print(f"{'id':>6} {'class':<16} {'vis':<5} {'x,y,w,h (client)':<28} {'style':<12} text")
    for cid, cls, vis, rc, txt, st in rows:
        print(f"{cid:>6} {cls:<16} {str(vis):<5} {str(rc):<28} 0x{st:08X} {txt[:70]}")


def cmd_settext(aid, txt):
    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    u.SendMessageW(ctl, 0x000C, 0, ctypes.c_wchar_p(txt))   # WM_SETTEXT
    u.InvalidateRect(ctl, None, True)
    print(f"WM_SETTEXT ctl{aid} <- {txt}")


def cmd_redraw(aid):
    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    u.InvalidateRect(ctl, None, True)
    u.UpdateWindow(ctl)
    print(f"redraw ctl{aid}")


def cmd_top(aid):
    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    # HWND_TOP=0 + SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
    u.SetWindowPos(ctl, 0, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010)
    print(f"ctl{aid} -> HWND_TOP")


def cmd_move(aid, x, y):
    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    u.SetWindowPos(ctl, 0, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010)
    u.InvalidateRect(ctl, None, True)
    print(f"ctl{aid} moved to {x},{y}")


def cmd_hit(aid):
    """取控件中心点, 打印该点上按 z 序第一个直接子窗口(判断是否被同层控件遮挡)"""
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    r = RECT()
    u.GetWindowRect(ctl, ctypes.byref(r))
    pt = POINT((r.left + r.right) // 2, (r.top + r.bottom) // 2)
    u.MapWindowPoints(0, hwnd, ctypes.byref(pt), 1)      # 屏幕 → 主窗口客户区
    top = u.ChildWindowFromPointEx(hwnd, pt, 0)
    print(f"ctl{aid} center=({pt.x},{pt.y}) → 顶层子窗口 id={u.GetDlgCtrlID(top)} "
          f"class={class_of(top) if top else ''} (本控件={ctl})")
    if top and top != ctl:
        print("  ⚠ 被同层控件遮挡: 该点鼠标不会落到本控件")



    hwnd = main_window()
    ctl = find_by_id(hwnd, aid)
    if not ctl:
        print(f"ctl{aid} not found")
        sys.exit(1)
    print(f"ctl{aid} class={class_of(ctl)} style=0x{u.GetWindowLongW(ctl, GWL_STYLE):08X} "
          f"exstyle=0x{u.GetWindowLongW(ctl, -20):08X} parent={u.GetParent(ctl)}")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "rect"
    arg = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if action == "click":
        cmd_click(arg)
    elif action == "btn":
        cmd_btn(arg)
    elif action == "rect":
        cmd_rect()
    elif action == "dump":
        cmd_dump()
    elif action == "redraw":
        cmd_redraw(arg)
    elif action == "top":
        cmd_top(arg)
    elif action == "style":
        cmd_style(arg)
    elif action == "hit":
        cmd_hit(arg)
    elif action == "move":
        cmd_move(arg, int(sys.argv[3]), int(sys.argv[4]))
    elif action == "settext":
        cmd_settext(arg, sys.argv[3] if len(sys.argv) > 3 else "D:\\Test\\Path\\Fntv-Plus")
    else:
        print("unknown action: " + action)
        sys.exit(1)
