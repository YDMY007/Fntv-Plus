package main

// potctl —— PotPlayer 外部控制助手（Windows）。
//
// PotPlayer 不像 MPV 有可供 Node 直接操控的富 IPC，但它内置了一套
// 基于 SendMessage(WM_USER) 的控制协议，可被外部进程查询播放位置/时长/状态。
// 本程序作为我们 app 的"桥"：由 Node 侧周期性 spawn 本程序，
// 读取 PotPlayer 当前播放进度并通过 stdout 以 JSON 返回。
//
// 命令协议（社区逆向，PotPlayer x64 Function Library 记载）：
//   向 PotPlayer 主窗口发送  SendMessage(hwnd, WM_USER(0x0400), <cmd>, 0)
//   cmd 的【返回值 LRESULT】即查询结果（毫秒 / 状态），无需回发窗口。
//   - 0x5002 (20482) = POT_GET_TOTAL_TIME    总时长(ms)
//   - 0x5004 (20484) = POT_GET_CURRENT_TIME  当前位置(ms)
//   - 0x5006 (20486) = POT_GET_PLAY_STATUS   播放状态(-1停止 / 1暂停 / 2播放中)
//
// 命令：
//   potctl find  -> {"found":true,"hwnd":<n>} 或 {"found":false}
//   potctl info  -> {"found":true,"position":<ms>,"duration":<ms>,"state":<-1|1|2>,
//                    "rect":{"left":<n>,"top":<n>,"right":<n>,"bottom":<n>}}
//                   (state: -1=停止 1=暂停 2=播放中；found:false 表示未找到窗口；
//                    rect 为 PotPlayer 主窗口在屏幕上的像素矩形，供弹幕 overlay 对齐)

import (
	"encoding/json"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmUser      = 0x0400 // WM_USER：PotPlayer 控制命令消息号
	cmdGetPos   = 20484  // 0x5004 当前播放位置(ms)
	cmdGetDur   = 20482  // 0x5002 总时长(ms)
	cmdGetState = 20486  // 0x5006 播放状态(-1停止/1暂停/2播放中)
)

// user32 延迟加载（x/sys/windows 未直接导出 FindWindow/SendMessage/GetWindowRect）
var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	procFindWindow   = user32.NewProc("FindWindowW")
	procSendMessage  = user32.NewProc("SendMessageW")
	procGetWindowRect = user32.NewProc("GetWindowRect")
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

type infoResult struct {
	Found    bool     `json:"found"`
	Position int64    `json:"position"`
	Duration int64    `json:"duration"`
	State    int      `json:"state"`
	Rect     *winRect `json:"rect,omitempty"`
	Error    string   `json:"error,omitempty"`
	Hwnd     int      `json:"hwnd,omitempty"`
}

// findPotPlayer 查找 PotPlayer 主窗口（64 位类名优先，回退 32 位）
func findPotPlayer() windows.HWND {
	candidates := []string{"PotPlayer64", "PotPlayer"}
	for _, cls := range candidates {
		r, _, _ := procFindWindow.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(cls))), 0)
		if r != 0 {
			return windows.HWND(r)
		}
	}
	return 0
}

// sendCmd 向 PotPlayer 发送一条查询命令并返回 LRESULT（即 PotPlayer 同步回传的数值）。
// 注意：命令用 WM_USER 消息，wParam 传命令码，lParam 传 0；返回值即查询数值，
// 这与 WM_COPYDATA 协议（lpData 回传）不同，是 PotPlayer 数值查询的正确用法。
func sendCmd(hwnd windows.HWND, cmd uintptr) (int64, error) {
	if hwnd == 0 {
		return 0, fmt.Errorf("hwnd is null")
	}
	r, _, _ := procSendMessage.Call(uintptr(hwnd), wmUser, cmd, 0)
	return int64(r), nil
}

// getWindowRect 取 PotPlayer 主窗口在屏幕上的像素矩形（供弹幕 overlay 对齐）。
func getWindowRect(hwnd windows.HWND) (winRect, error) {
	var r winRect
	if hwnd == 0 {
		return r, fmt.Errorf("hwnd is null")
	}
	_, _, err := procGetWindowRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&r)))
	return r, err
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println(`{"found":false,"error":"usage: potctl <find|info>"}`)
		os.Exit(0)
	}

	switch os.Args[1] {
	case "find":
		hwnd := findPotPlayer()
		if hwnd == 0 {
			fmt.Println(`{"found":false}`)
		} else {
			fmt.Printf(`{"found":true,"hwnd":%d}`+"\n", int(hwnd))
		}

	case "info":
		hwnd := findPotPlayer()
		if hwnd == 0 {
			fmt.Println(`{"found":false}`)
			return
		}
		pos, _ := sendCmd(hwnd, cmdGetPos)
		dur, _ := sendCmd(hwnd, cmdGetDur)
		st, _ := sendCmd(hwnd, cmdGetState)

		// 状态归一化：PotPlayer 返回 -1/1/2。在 WoW64（32 位 PotPlayer）下，负数可能被
		// 零扩展为 0xFFFFFFFF，故取低 32 位按 int32 解读，确保 -1 正确。
		stateNorm := int(int32(uint32(st & 0xFFFFFFFF)))

		rect, _ := getWindowRect(hwnd)

		res := infoResult{
			Found:    true,
			Position: pos,
			Duration: dur,
			State:    stateNorm,
			Rect:     &rect,
		}
		b, _ := json.Marshal(res)
		fmt.Println(string(b))

	default:
		fmt.Printf(`{"found":false,"error":"unknown command %s"}`+"\n", os.Args[1])
	}
}
