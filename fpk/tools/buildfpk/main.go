// buildfpk —— Fntv-Plus 一键打包成飞牛 FPK 应用（Windows 测试用）。
//
// 编译（在 fntvplus/ 仓库根）：
//	go build -o build-fpk.exe ./tools/buildfpk
//
// 功能（双击 一键打包.bat 或命令行运行 build-fpk.exe）：
//  1. （可选）node scripts/build-userjs.mjs 重建网页端 payload，并同步到 Go embed 目录
//  2. go build 交叉编译 linux/amd64 后端 -> app/server/fntvplus
//     （fnpack 只打包 app/ 目录内容，二进制必须在这里才能进包）
//  3. fnpack build 打出 fntvplus.fpk
//
// 任何一步缺工具（node/go/fnpack）都会降级或给出明确提示。
package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sort"
	"strings"
)

var root string

func main() {
	// 三种调用：
	//   build-fpk.exe            —— 一次性 CLI 打包（旧用法，版号自动 +1）
	//   build-fpk.exe build      —— 同上（显式子命令，与 bat 注释一致）
	//   build-fpk.exe --serve    —— 网页 GUI（设置显示名/正式版号，点按钮打包，包名 Fntv-Plus-vXYZ）
	for _, a := range os.Args[1:] {
		if a == "--serve" {
			serveGUI()
			return
		}
		if a == "build" {
			break
		}
	}
	// 注意：不做交互式 Scanln 阻塞（避免管道/自动化场景卡死）；
	// 双击使用请走 一键打包.bat，由 bat pause 停住窗口。
	if err := run(); err != nil {
		fmt.Printf("\n[X] %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	root = filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(root, "manifest")); err != nil {
		return fmt.Errorf("在 %s 找不到 manifest，请把 build-fpk.exe 放在 fpk/ 目录（Fntv-Plus 仓库内 Web 版子目录）", root)
	}

	fmt.Println("==============================================")
	fmt.Println(" Fntv-Plus 一键打包成飞牛 FPK 应用")
	fmt.Println("==============================================")
	fmt.Printf("项目根: %s\n\n", root)

	// ---- Step 0: 开发版号 = max(git commit 数, 历史痕迹最大包号+1)（开发包小 v + 序号，严格递增）----
	devVer := devCommitVersion()
	writeVersion(devVer)
	fmt.Printf("开发版号: %s\n", devVer)

	// ---- Step 1: 重建 payload（可选）----
	syncPayload()

	// ---- Step 2: 交叉编译后端 ----
	bin := filepath.Join(root, "app", "server", "fntvplus")
	if err := buildBackend(bin); err != nil {
		return err
	}

	// ---- Step 3: fnpack 打包 ----
	fpk, err := pack()
	if err != nil {
		return err
	}

	ver := manifestVersion()
	sizeMB := "0"
	if st, err := os.Stat(fpk); err == nil {
		sizeMB = fmt.Sprintf("%.1f", float64(st.Size())/1024/1024)
	}
	fmt.Println("\n==============================================")
	fmt.Println("[OK] 打包完成！")
	fmt.Printf("  产物: %s (%s MB)\n", fpk, sizeMB)
	fmt.Printf("  版本: %s\n", ver)
	fmt.Println("  安装: 把该 .fpk 上传到飞牛 fnOS 应用中心本地安装，")
	fmt.Println("        或用 appcenter-cli install-local 安装测试。")
	fmt.Println("==============================================")
	return nil
}

// syncPayload 若 node 可用则重建 dist/fntv-plus.user.js 并同步到 Go embed 目录；
// node 不可用则沿用仓库里已提交的 embed payload。
func syncPayload() {
	node, _ := exec.LookPath("node")
	if node == "" {
		fmt.Println("[skip] 未找到 node，使用已内置的 payload（如改了网页端源码请装 node 后重跑）")
		return
	}
	script := filepath.Join(root, "scripts", "build-userjs.mjs")
	if _, err := os.Stat(script); err != nil {
		fmt.Println("[skip] scripts/build-userjs.mjs 不存在，跳过 payload 重建")
		return
	}
	fmt.Println("[1/3] 重建网页端 payload (esbuild)...")
	cmd := exec.Command(node, script)
	cmd.Dir = root
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Printf("[warn] payload 重建失败（%v），继续使用现有 payload\n", err)
		return
	}
	dist := filepath.Join(root, "dist", "fntv-plus.user.js")
	embed := filepath.Join(root, "src", "go", "internal", "inject", "payload", "fntv-plus.user.js")
	if err := copyFile(dist, embed); err != nil {
		fmt.Printf("[warn] payload 同步到 embed 目录失败: %v\n", err)
		return
	}
	fmt.Println("       dist/fntv-plus.user.js -> src/go/internal/inject/payload/ 同步完成")
}

// buildBackend 交叉编译 linux/amd64 后端到 app/server/fntvplus。
func buildBackend(bin string) error {
	fmt.Println("[2/3] 交叉编译后端 (linux/amd64)...")
	goBin, _ := exec.LookPath("go")
	if goBin == "" {
		if _, err := os.Stat(bin); err == nil {
			fmt.Println("[skip] 未找到 go，复用已有 app/server/fntvplus")
			return nil
		}
		return fmt.Errorf("未找到 go 工具链，且 app/server/fntvplus 不存在；请安装 Go 1.23+ 后重跑")
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		return err
	}
	// 先编译到 src/go 目录内（个别环境下 -o 指向目录外会静默失败），再移动到 app/server/
	tmp := filepath.Join(root, "src", "go", "fntvplus_linux_amd64")
	// [lc-167] 编译期注入版号兜底：-X main.buildVersion=<manifest version>
	//   （运行时优先 TRIM_APPVER / 磁盘 manifest；注入值保证取不到文件时界面仍显示正确版号）
	args := []string{"build"}
	if v := manifestVersion(); v != "" && v != "?" {
		args = append(args, "-ldflags", "-X main.buildVersion="+v)
	}
	args = append(args, "-o", "fntvplus_linux_amd64", "./cmd/fntvplus")
	cmd := exec.Command(goBin, args...)
	cmd.Dir = filepath.Join(root, "src", "go")
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH=amd64", "CGO_ENABLED=0")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("后端编译失败: %w", err)
	}
	if _, err := os.Stat(tmp); err != nil {
		return fmt.Errorf("编译命令成功但产物缺失: %s", tmp)
	}
	if err := os.Rename(tmp, bin); err != nil {
		// rename 跨盘等场景兜底用复制
		if err2 := copyFile(tmp, bin); err2 != nil {
			return fmt.Errorf("移动编译产物失败: %v / %v", err, err2)
		}
		_ = os.Remove(tmp)
	}
	if _, err := os.Stat(bin); err != nil {
		return fmt.Errorf("编译产物最终缺失: %s", bin)
	}
	fmt.Println("       app/server/fntvplus 编译完成")
	return nil
}

// pack 调 fnpack build 打出 .fpk。
func pack() (string, error) {
	fnpack, err := findFnpack()
	if err != nil {
		return "", err
	}
	fmt.Printf("[3/3] fnpack 打包 (%s)...\n", fnpack)

	// 清理旧包，避免误报成功
	old := filepath.Join(root, "fntvplus.fpk")
	_ = os.Remove(old)

	cmd := exec.Command(fnpack, "build")
	cmd.Dir = root
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("fnpack build 失败: %w", err)
	}
	out := filepath.Join(root, "fntvplus.fpk")
	if st, err := os.Stat(out); err != nil || st.Size() < 1024 {
		return "", fmt.Errorf("fnpack 未产出有效的 fntvplus.fpk（请检查上方报错）")
	}
	// 开发包命名: 小 v + 序号（Fntv-Plus-v194 形态区分发布版大写 V）
	// 版号 x.y.z-<seq>（飞牛商店规则：3 段式 + 数字预发布后缀；4 段式无效）→ 取 "-" 后的数字
	if ver := manifestVersion(); strings.Contains(ver, "-") {
		if n, err := strconv.Atoi(strings.TrimPrefix(ver, strings.SplitN(ver, "-", 2)[0]+"-")); err == nil {
			named := filepath.Join(root, "Fntv-Plus-v"+strconv.Itoa(n)+".fpk")
			if err := os.Rename(out, named); err == nil {
				// [v1.11.x] 自动清理上一个开发包（用户要求）：只删同名前缀(小写 v)旧产物，
				// 刚打出的保留；发布包是大写 V 前缀，大小写敏感比较天然不误删。
				cleanOldDevPackages(named)
				return named, nil
			}
		}
	}
	return out, nil
}

// cleanOldDevPackages 删除根目录下除 keep 外的全部开发包（Fntv-Plus-v*.fpk，小写 v）。
// 手工遍历而非 Glob：Windows 下 Glob 大小写不敏感，会把发布包 Fntv-Plus-V*.fpk 一并匹配进来。
func cleanOldDevPackages(keep string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	removed := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "Fntv-Plus-v") || !strings.HasSuffix(name, ".fpk") {
			continue
		}
		p := filepath.Join(root, name)
		if p == keep {
			continue
		}
		if err := os.Remove(p); err == nil {
			fmt.Printf("       已清理旧包: %s\n", name)
			removed++
		}
	}
	if removed == 0 {
		fmt.Println("       无旧开发包需要清理")
	}
}

// findFnpack 依次查找 tools/fnpack.exe、用户 Downloads 下的 fnpack*。
func findFnpack() (string, error) {
	local := filepath.Join(root, "tools", "fnpack.exe")
	if _, err := os.Stat(local); err == nil {
		return local, nil
	}
	home, _ := os.UserHomeDir()
	hits, _ := filepath.Glob(filepath.Join(home, "Downloads", "fnpack*"))
	sort.Strings(hits) // 稳定顺序，取最新版本名（字典序对 1.2.3 这类版本号够用）
	for _, h := range hits {
		if st, err := os.Stat(h); err == nil && !st.IsDir() {
			return h, nil
		}
	}
	return "", fmt.Errorf("找不到 fnpack：请把 fnpack-<ver>-windows-amd64 复制为 %s（或放到 Downloads 下）",
		filepath.Join("fpk", "tools", "fnpack.exe"))
}

// devCommitVersion 开发测试版号 = <发布版基号>-<序号>，**严格递增**。
// 飞牛商店审核规则：版本号固定 3 段式 x.y.z；可带后缀 -m（仅数字才有版本对比逻辑）。
// 旧实现的 4 段式（1.0.0.193）属审核违规 → 改为数字预发布后缀 1.0.0-193（语义化版本
// 预发布号 < 正式版：1.0.0-193 < 1.0.0 ≤ 下一正式版 1.0.1，覆盖关系不变）。
// 序号取法（沿用 [v1.11.x] 严格递增）——取三者最大：
//   ① git 提交数（正常节奏：先提交后打包，版号=提交数）；
//   ② 历史痕迹里的最大包号 +1：根目录残留的 Fntv-Plus-vN.fpk 包名（*.fpk 不入库，
//     cleanOldDevPackages 又会删旧包，manifest 版号可能被手工拨回——残留包名是
//     "已装到 NAS 的最高版"唯一的本地证据，缺了它本地号追不上应用商店已装版
//     → 覆盖安装被拒，用户报"版号对不上"）；
//   ③ git 不可用时退化为当前包号 +1。
//   即 seq = max(提交数, 痕迹最大包号+1)；再与 manifest 后缀比取大，仍严格递增。
// ⚠ 若安装器对预发布号与正式版的覆盖方向与预期不符（如拒装 -n 覆盖 1.0.0），
//   回退方案=测试前卸载正式版。
func devCommitVersion() string {
	base := manifestGetString("release_version", "1.0.0")
	cur := 0
	if ver := manifestVersion(); strings.HasPrefix(ver, base+"-") {
		if n, err := strconv.Atoi(strings.TrimPrefix(ver, base+"-")); err == nil {
			cur = n
		}
	}
	seq := cur
	// 痕迹：根目录残留开发包名 Fntv-Plus-v<NNN>.fpk（*.fpk 不入库、旧包会被自动清理，
	// manifest 版号也可能被手工拨回——残留包名是"本地打包历史最高版"唯一可靠的证据；
	// 缺了它本地号追不上应用商店已装版 → 覆盖安装被拒，用户报"版号对不上"）。
	if n, ok := maxHistorySeq(); ok && n > seq {
		seq = n
	}
	seq++ // 无新提交重复打包版号也必须前进（否则安装器视为同版本拒装）
	// 本仓库已合并桌面版（fpk/ 是 Web 版子目录）：全仓库提交数混入桌面版提交，
	// 且序号线必须与商店已装的 22x 连续 —— 只数 fpk/ 目录下的提交。
	gitCount := exec.Command("git", "rev-list", "--count", "HEAD", "--", ".")
	gitCount.Dir = root
	if out, err := gitCount.Output(); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil && n > seq {
			return base + "-" + strconv.Itoa(n) // 提交数更高（正常节奏）→ 版号=提交数
		}
	}
	return base + "-" + strconv.Itoa(seq)
}

// maxHistorySeq 扫根目录 Fntv-Plus-v<数字>.fpk（小写 v 开发包），返回最大 N。
func maxHistorySeq() (int, bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, false
	}
	re := regexp.MustCompile(`^Fntv-Plus-v(\d+)\.fpk$`)
	max, ok := 0, false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if m := re.FindStringSubmatch(e.Name()); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n > max {
				max, ok = n, true
			}
		}
	}
	return max, ok
}

// writeVersion 把 version 写回 manifest（开发版流程用；发布版号存 release_version 独立键）。
func writeVersion(ver string) {
	path := filepath.Join(root, "manifest")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	updated := regexp.MustCompile(`(?m)^(\s*version\s*=\s*)\S+`).ReplaceAllString(string(data), "${1}"+ver)
	_ = os.WriteFile(path, []byte(updated), 0o644)
}

func manifestVersion() string {
	data, err := os.ReadFile(filepath.Join(root, "manifest"))
	if err != nil {
		return "?"
	}
	m := regexp.MustCompile(`(?m)^\s*version\s*=\s*(\S+)`).FindStringSubmatch(string(data))
	if len(m) < 2 {
		return "?"
	}
	return strings.TrimSpace(m[1])
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
