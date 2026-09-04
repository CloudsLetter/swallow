use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
	pub application: Application,
	pub cloud: Cloud,
	pub appearance: Appearance,
	pub terminal: Terminal,
	pub ssh: SshSettings,
	pub shortcuts: ShortcutBinding,
	pub security: Security,
	pub advanced: Advanced,
	pub file_version: FileVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Application {
	pub initialized: bool,
	/// 初次使用引导是否已完成（老 config 缺字段视为 false，前端以「主机列表为空」二次闸定夺是否弹）
	#[serde(default)]
	pub onboarding_done: bool,
	// reserved
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FileVersion {
	pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Cloud {
	pub enabled: bool,
	pub server_host: String,
	pub server_port: u32,
	pub server_key: String,
	pub sync_policy: u32, // 0: upload only, 1: download only, 2: bidirectional, 3: manual
	pub sync_interval: u32,
	pub sync_hosts: bool,
	pub sync_keys: bool,
	pub sync_settings: bool,
	pub sync_snippets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Appearance {
	pub auto_detect_system_theme: bool,
	pub active_theme_id: String,
	pub themes: Vec<ThemePreset>,
	pub font_family: String,
	pub font_size: u32,
	pub language: String,
	// 滚动条：覆盖式（不占布局宽度）与宽度（px）
	#[serde(default = "default_scrollbar_overlay")]
	pub scrollbar_overlay: bool,
	#[serde(default = "default_scrollbar_width")]
	pub scrollbar_width: u32,
	// 界面缩放（WebView zoom 倍率，1.0 = 100%）：低分辨率屏（1080p@100%系统缩放）
	// 下整体等比放大 UI，对标 VS Code 的 window.zoomLevel
	#[serde(default = "default_ui_scale")]
	pub ui_scale: f32,
	// 窗口毛玻璃效果："none" | "acrylic" | "mica" | "blur"（Windows 专属，需窗口透明）
	#[serde(default = "default_window_effect")]
	pub window_effect: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemePreset {
	pub id: String,
	pub name: String,
	pub colors: ThemeColors,
	pub built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeColors {
	// 主题色
	pub primary: String,
	pub primary_light: String,
	pub primary_dark: String,

	// 语义色
	pub success: String,
	pub warning: String,
	pub error: String,
	pub info: String,

	// 文本色
	pub text_primary: String,
	pub text_muted: String,
	pub text_secondary: String,
	pub text_tertiary: String,
	pub text_disabled: String,
	pub text_placeholder: String,
	pub text_link: String,

	// 表面层
	pub bg_primary: String,
	pub surface: String,
	pub surface_elevated: String,

	// 按钮
	pub btn_primary_bg: String,
	pub btn_primary_text: String,
	pub btn_primary_hover: String,
	pub btn_secondary_bg: String,
	pub btn_secondary_text: String,
	pub btn_danger_bg: String,
	pub btn_danger_text: String,

	// 控件 / 边框 / 输入
	pub border_primary: String,
	pub border_focus: String,
	pub input_bg: String,
	pub input_text: String,
	pub input_placeholder: String,
	pub control_disabled_bg: String,
	pub control_disabled_text: String,
	pub focus_ring: String,

	// 顶部栏与标签
	pub topbar_bg: String,
	pub tab_bg: String,
	pub tab_bg_active: String,
	pub tab_text_color: String,
	pub tab_text_color_active: String,
	pub tab_icon_color: String,
	pub tab_icon_color_active: String,
	pub tab_border_color: String,
	pub window_control_btn_icon_color: String,

	// 菜单 / 右键
	pub context_menu_bg: String,
	pub context_menu_border: String,
	pub context_menu_shadow: String,
	pub context_menu_item_text: String,
	pub context_menu_item_hover: String,
	pub context_menu_item_disabled: String,

	// 侧边菜单
	pub sidemenu_bg: String,
	pub menu_border_primary: String,
	pub sidemenu_text: String,
	pub sidemenu_text_active: String,

	// 滚动条 / 覆盖 / 分隔线
	pub scrollbar_track: String,
	pub scrollbar_thumb: String,
	pub scrollbar_thumb_hover: String,
	pub overlay: String,
	pub divider: String,

	// 交互状态
	pub selected_bg: String,
	pub selected_text: String,
	pub hover_bg: String,
	pub active_bg: String,

	// 阴影层级
	pub shadow_sm: String,
	pub shadow_md: String,
	pub shadow_lg: String,
	pub shadow_xl: String,

	// 可访问性与高对比
	pub high_contrast_text: String,

	// 面板
	pub panel_bg: String,
	pub panel_border: String,
}



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Terminal {
	// 主题
	pub active_theme_id: String,
	pub themes: Vec<TerminalThemePreset>,

	// 字体
	pub font_family: String,
	pub font_size: u32,
	pub line_height: f32,
	pub font_weight: u32,
	pub font_weight_bold: u32,

	// 光标
	pub cursor_style: CursorStyle,
	pub cursor_blink: bool,
	pub cursor_width: u32,

	// 滚动
	pub scrollback: u32,
	pub scroll_sensitivity: f32,
	pub fast_scroll_sensitivity: f32,

	// 外观
	pub background_opacity: f32,
	pub allow_transparent_background: bool,
	pub draw_bold_text_in_bright_colors: bool,

	// 背景图片（本地路径或 http(s)/data URL）
	#[serde(default)]
	pub background_image: String,
	#[serde(default = "default_background_image_opacity")]
	pub background_image_opacity: f32,
	#[serde(default = "default_background_image_blur")]
	pub background_image_blur: f32,
	/// 终端背景延伸至顶部标签栏（Topbar 透出当前终端的背景色/背景图）
	#[serde(default)]
	pub extend_background_to_topbar: bool,
	/// 选中文本背景透明度（0.0 全透明 - 1.0 实色；默认 0.4 半透明，透出背景图/底色）
	#[serde(default = "default_selection_opacity")]
	pub selection_opacity: f32,

	// 行为
	pub enable_bell: bool,
	pub bell_style: BellStyle,
	pub right_click_selects_word: bool,
	pub copy_on_select: bool,
	pub scroll_on_input: bool,

	// 兼容性
	pub legacy_color_scheme: ColorScheme,
	pub auto_connect: bool,

	// 渲染引擎（"dom" | "canvas" | "webgl"，默认 dom 保持既有渲染行为；webgl 即 GPU 渲染）
	#[serde(default = "default_render_engine")]
	pub render_engine: String,
	/// GPU 加速总开关：关闭时即便引擎选了 webgl 也降级用 canvas
	#[serde(default = "default_gpu_acceleration")]
	pub gpu_acceleration: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalThemePreset {
	pub id: String,
	pub name: String,
	pub colors: TerminalThemeColors,
	pub built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalThemeColors {
	// ANSI 颜色 (0-15)
	pub black: String,          // ANSI 0
	pub red: String,            // ANSI 1
	pub green: String,          // ANSI 2
	pub yellow: String,         // ANSI 3
	pub blue: String,           // ANSI 4
	pub magenta: String,        // ANSI 5
	pub cyan: String,           // ANSI 6
	pub white: String,          // ANSI 7
	pub bright_black: String,   // ANSI 8
	pub bright_red: String,     // ANSI 9
	pub bright_green: String,   // ANSI 10
	pub bright_yellow: String,  // ANSI 11
	pub bright_blue: String,    // ANSI 12
	pub bright_magenta: String, // ANSI 13
	pub bright_cyan: String,    // ANSI 14
	pub bright_white: String,   // ANSI 15

	// 终端基础颜色
	pub foreground: String,     // 前景色（默认文本）
	pub background: String,     // 背景色
	pub cursor: String,         // 光标颜色
	pub cursor_accent: String,  // 光标高亮色
	pub selection: String,      // 选中文本背景色
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CursorStyle {
	#[serde(rename = "block")]
	Block,
	#[serde(rename = "underline")]
	Underline,
	#[serde(rename = "bar")]
	Bar,
}

impl Default for CursorStyle {
    fn default() -> Self {
        Self::Block
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BellStyle {
	#[serde(rename = "none")]
	None,
	#[serde(rename = "visual")]
	Visual,
	#[serde(rename = "sound")]
	Sound,
	#[serde(rename = "both")]
	Both,
}

impl Default for BellStyle {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ColorScheme {
	#[serde(rename = "default")]
	Default,
	#[serde(rename = "solarized-dark")]
	SolarizedDark,
	#[serde(rename = "monokai")]
	Monokai,
	#[serde(rename = "dracula")]
	Dracula,
}

impl Default for ColorScheme {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SshSettings {
	pub connection_timeout: u32,
	pub keep_alive_interval: u32,
	pub auto_reconnect: bool,
	pub max_reconnect_attempts: u32,
	pub default_port: u16,
	pub compression: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShortcutBinding {
	pub new_tab: String,
	pub close_tab: String,
	pub next_tab: String,
	pub prev_tab: String,
	pub copy: String,
	pub paste: String,
	pub find: String,
	/// 终端内复制（Ctrl+C 在终端是 SIGINT，故终端复制/粘贴默认走 Ctrl+Shift+*）
	#[serde(default)]
	pub terminal_copy: String,
	/// 终端内粘贴
	#[serde(default)]
	pub terminal_paste: String,
	/// 终端内全选
	#[serde(default)]
	pub terminal_select_all: String,
	pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Security {
	pub encrypt_passwords: bool,
	pub session_timeout: u32,
	pub lock_on_suspend: bool,
	pub clear_clipboard_after: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Advanced {
	pub auto_save: bool,
	pub restore_sessions: bool,
	pub confirm_on_close: bool,
	pub minimize_to_tray: bool,
	pub max_logs: u32,
	pub enable_debug_log: bool,
	/// 调试模式：开启前端 console 捕获面板（并尝试打开开发者工具）
	#[serde(default)]
	pub debug_mode: bool,
	pub check_updates: bool,
	pub send_analytics: bool,
}

impl Config {
	pub fn refresh_builtin_themes(mut self) -> Self {
		let default_appearance = Appearance::default();
		let existing_themes = std::mem::take(&mut self.appearance.themes);
		let mut custom_themes: Vec<ThemePreset> = existing_themes
			.into_iter()
			.filter(|theme| !theme.built_in)
			.collect();

		let mut merged_themes = default_appearance.themes;
		merged_themes.append(&mut custom_themes);
		self.appearance.themes = merged_themes;

		if !self
			.appearance
			.themes
			.iter()
			.any(|theme| theme.id == self.appearance.active_theme_id)
		{
			self.appearance.active_theme_id = default_appearance.active_theme_id;
		}

		self
	}

	/// 合并内置终端配色：保留用户自定义（built_in=false）配色，重新注入内置配色；
	/// 若 active_theme_id 指向的配色不存在，则回退到内置默认。
	pub fn refresh_builtin_terminal_themes(mut self) -> Self {
		let default_terminal = Terminal::default();
		let existing = std::mem::take(&mut self.terminal.themes);
		let mut custom: Vec<TerminalThemePreset> = existing
			.into_iter()
			.filter(|t| !t.built_in)
			.collect();

		let mut merged = default_terminal.themes;
		merged.append(&mut custom);
		self.terminal.themes = merged;

		if !self
			.terminal
			.themes
			.iter()
			.any(|t| t.id == self.terminal.active_theme_id)
		{
			self.terminal.active_theme_id = default_terminal.active_theme_id;
		}

		self
	}
}

impl Default for Config {
	fn default() -> Self {
		Self {
			application: Application::default(),
			cloud: Cloud::default(),
			appearance: Appearance::default(),
			terminal: Terminal::default(),
			ssh: SshSettings::default(),
			shortcuts: ShortcutBinding::default(),
			security: Security::default(),
			advanced: Advanced::default(),
			file_version: FileVersion::default(),
		}
	}
}

impl Default for Application {
	fn default() -> Self {
		Self {
			initialized: false,
			onboarding_done: false,
		}
	}
}

impl Default for FileVersion {
	fn default() -> Self {
		Self {
			version: "0".into(),
		}
	}
}

impl Default for Cloud {
	fn default() -> Self {
		Self {
			enabled: false,
			server_host: "".into(),
			server_port: 0,
			server_key: "".into(),
			sync_policy: 0,
			sync_interval: 0,
			sync_hosts: false,
			sync_keys: false,
			sync_settings: false,
			sync_snippets: false,
		}
	}
}

impl Default for Appearance {
	fn default() -> Self {
		// 定义默认亮色主题
		let light_theme = ThemePreset {
			id: "default-theme-light".into(),
			name: "默认亮色".into(),
			colors: ThemeColors {
				// 主题色（现代靛蓝 Indigo）
				primary: "#4f46e5".into(),
				primary_light: "#818cf8".into(),
				primary_dark: "#4338ca".into(),

				// 语义色
				success: "#059669".into(),
				warning: "#d97706".into(),
				error: "#dc2626".into(),
				info: "#0891b2".into(),

				// 文本色
				text_primary: "#1e1b4b".into(),
				text_muted: "#6b7280".into(),
				text_secondary: "#4b5563".into(),
				text_tertiary: "#9ca3af".into(),
				text_disabled: "#cbd5e1".into(),
				text_placeholder: "#9ca3af".into(),
				text_link: "#4f46e5".into(),

				// 表面层
				bg_primary: "#f8fafc".into(),
				surface: "#f1f5f9".into(),
				surface_elevated: "#ffffff".into(),

				// 按钮
				btn_primary_bg: "#4f46e5".into(),
				btn_primary_text: "#ffffff".into(),
				btn_primary_hover: "#4338ca".into(),
				btn_secondary_bg: "#eef2ff".into(),
				btn_secondary_text: "#3730a3".into(),
				btn_danger_bg: "#dc2626".into(),
				btn_danger_text: "#ffffff".into(),

				// 控件 / 边框 / 输入
				border_primary: "#e2e8f0".into(),
				border_focus: "#6366f1".into(),
				input_bg: "#ffffff".into(),
				input_text: "#1e1b4b".into(),
				input_placeholder: "#94a3b8".into(),
				control_disabled_bg: "#f1f5f9".into(),
				control_disabled_text: "#9ca3af".into(),
				focus_ring: "#6366f1".into(),

				// 顶部栏与标签
				topbar_bg: "#ffffff".into(),
				tab_bg: "#f1f5f9".into(),
				tab_bg_active: "#ffffff".into(),
				tab_text_color: "#64748b".into(),
				tab_text_color_active: "#1e1b4b".into(),
				tab_icon_color: "#94a3b8".into(),
				tab_icon_color_active: "#4f46e5".into(),
				tab_border_color: "#e2e8f0".into(),
				window_control_btn_icon_color: "#64748b".into(),

				// 菜单 / 右键
				context_menu_bg: "#ffffff".into(),
				context_menu_border: "#e2e8f0".into(),
				context_menu_shadow: "rgba(30, 27, 75, 0.08)".into(),
				context_menu_item_text: "#334155".into(),
				context_menu_item_hover: "#eef2ff".into(),
				context_menu_item_disabled: "#cbd5e1".into(),

				// 侧边菜单
				sidemenu_bg: "#eef2ff".into(),
				menu_border_primary: "#e2e8f0".into(),
				sidemenu_text: "#64748b".into(),
				sidemenu_text_active: "#1e1b4b".into(),

				// 滚动条 / 覆盖 / 分隔线
				scrollbar_track: "#f1f5f9".into(),
				scrollbar_thumb: "#cbd5e1".into(),
				scrollbar_thumb_hover: "#a5b4fc".into(),
				overlay: "rgba(30, 27, 75, 0.36)".into(),
				divider: "#e2e8f0".into(),

				// 交互状态
				selected_bg: "#e0e7ff".into(),
				selected_text: "#3730a3".into(),
				hover_bg: "#eef2ff".into(),
				active_bg: "#e0e7ff".into(),

				// 阴影层级
				shadow_sm: "0 1px 2px rgba(30, 27, 75, 0.06)".into(),
				shadow_md: "0 12px 28px rgba(30, 27, 75, 0.08)".into(),
				shadow_lg: "0 20px 42px rgba(30, 27, 75, 0.10)".into(),
				shadow_xl: "0 30px 56px rgba(30, 27, 75, 0.12)".into(),

				// 可访问性与高对比
				high_contrast_text: "#1e1b4b".into(),

				// 面板
				panel_bg: "#ffffff".into(),
				panel_border: "#e2e8f0".into(),
			},
			built_in: true,
		};

		// 定义默认深色主题
		let dark_theme = ThemePreset {
			id: "default-theme-dark".into(),
			name: "默认深色".into(),
			colors: ThemeColors {
				// 主题色（现代靛蓝 Indigo）
				primary: "#818cf8".into(),
				primary_light: "#a5b4fc".into(),
				primary_dark: "#6366f1".into(),

				// 语义色
				success: "#34d399".into(),
				warning: "#fbbf24".into(),
				error: "#f87171".into(),
				info: "#22d3ee".into(),

				// 文本色
				text_primary: "#eef2ff".into(),
				text_muted: "#94a3b8".into(),
				text_secondary: "#cbd5e1".into(),
				text_tertiary: "#64748b".into(),
				text_disabled: "#475569".into(),
				text_placeholder: "#64748b".into(),
				text_link: "#a5b4fc".into(),

				// 表面层
				bg_primary: "#0f172a".into(),
				surface: "#1e293b".into(),
				surface_elevated: "#273449".into(),

				// 按钮
				btn_primary_bg: "#818cf8".into(),
				btn_primary_text: "#1e1b4b".into(),
				btn_primary_hover: "#a5b4fc".into(),
				btn_secondary_bg: "#273449".into(),
				btn_secondary_text: "#e2e8f0".into(),
				btn_danger_bg: "#e11d48".into(),
				btn_danger_text: "#ffffff".into(),

				// 控件 / 边框 / 输入
				border_primary: "#334155".into(),
				border_focus: "#818cf8".into(),
				input_bg: "#1e293b".into(),
				input_text: "#eef2ff".into(),
				input_placeholder: "#64748b".into(),
				control_disabled_bg: "#1e293b".into(),
				control_disabled_text: "#64748b".into(),
				focus_ring: "#818cf8".into(),

				// 顶部栏与标签
				topbar_bg: "#0f172a".into(),
				tab_bg: "#1e293b".into(),
				tab_bg_active: "#273449".into(),
				tab_text_color: "#94a3b8".into(),
				tab_text_color_active: "#eef2ff".into(),
				tab_icon_color: "#64748b".into(),
				tab_icon_color_active: "#a5b4fc".into(),
				tab_border_color: "#334155".into(),
				window_control_btn_icon_color: "#94a3b8".into(),

				// 菜单 / 右键
				context_menu_bg: "#1e293b".into(),
				context_menu_border: "#334155".into(),
				context_menu_shadow: "rgba(2, 6, 23, 0.50)".into(),
				context_menu_item_text: "#e2e8f0".into(),
				context_menu_item_hover: "#273449".into(),
				context_menu_item_disabled: "#64748b".into(),

				// 侧边菜单
				sidemenu_bg: "#111c33".into(),
				menu_border_primary: "#334155".into(),
				sidemenu_text: "#94a3b8".into(),
				sidemenu_text_active: "#eef2ff".into(),

				// 滚动条 / 覆盖 / 分隔线
				scrollbar_track: "#0f172a".into(),
				scrollbar_thumb: "#334155".into(),
				scrollbar_thumb_hover: "#475569".into(),
				overlay: "rgba(2, 6, 23, 0.72)".into(),
				divider: "#334155".into(),

				// 交互状态
				selected_bg: "#3730a3".into(),
				selected_text: "#c7d2fe".into(),
				hover_bg: "#273449".into(),
				active_bg: "#312e81".into(),

				// 阴影层级
				shadow_sm: "0 1px 2px rgba(2, 6, 23, 0.34)".into(),
				shadow_md: "0 14px 30px rgba(2, 6, 23, 0.28)".into(),
				shadow_lg: "0 24px 48px rgba(2, 6, 23, 0.36)".into(),
				shadow_xl: "0 36px 72px rgba(2, 6, 23, 0.42)".into(),

				// 可访问性与高对比
				high_contrast_text: "#ffffff".into(),

				// 面板
				panel_bg: "#1e293b".into(),
				panel_border: "#334155".into(),
			},
			built_in: true,
		};

		let glass_theme = ThemePreset {
			id: "glass-theme-dark".into(),
			name: "玻璃（透明）".into(),
			colors: ThemeColors {
				// 主题色（现代靛蓝 Indigo，同深色主题）
				primary: "#818cf8".into(),
				primary_light: "#a5b4fc".into(),
				primary_dark: "#6366f1".into(),

				// 语义色
				success: "#34d399".into(),
				warning: "#fbbf24".into(),
				error: "#f87171".into(),
				info: "#22d3ee".into(),

				// 文本色（不透明，保证毛玻璃上可读）
				text_primary: "#eef2ff".into(),
				text_muted: "#94a3b8".into(),
				text_secondary: "#cbd5e1".into(),
				text_tertiary: "#64748b".into(),
				text_disabled: "#475569".into(),
				text_placeholder: "#64748b".into(),
				text_link: "#a5b4fc".into(),

				// 表面层 —— 半透明，让 Acrylic 毛玻璃/壁纸透出；
				// 透明度梯度：最底层最透、卡片次之、菜单/弹层最实（保可读）
				bg_primary: "rgba(15, 23, 42, 0.38)".into(),
				surface: "rgba(30, 41, 59, 0.45)".into(),
				surface_elevated: "rgba(39, 52, 73, 0.55)".into(),

				// 按钮
				btn_primary_bg: "#818cf8".into(),
				btn_primary_text: "#1e1b4b".into(),
				btn_primary_hover: "#a5b4fc".into(),
				btn_secondary_bg: "rgba(39, 52, 73, 0.65)".into(),
				btn_secondary_text: "#e2e8f0".into(),
				btn_danger_bg: "#e11d48".into(),
				btn_danger_text: "#ffffff".into(),

				// 控件 / 边框 / 输入
				border_primary: "rgba(148, 163, 184, 0.28)".into(),
				border_focus: "#818cf8".into(),
				input_bg: "rgba(30, 41, 59, 0.6)".into(),
				input_text: "#eef2ff".into(),
				input_placeholder: "#64748b".into(),
				control_disabled_bg: "rgba(30, 41, 59, 0.6)".into(),
				control_disabled_text: "#64748b".into(),
				focus_ring: "#818cf8".into(),

				// 顶部栏与标签（半透明，毛玻璃顶栏）
				topbar_bg: "rgba(15, 23, 42, 0.4)".into(),
				tab_bg: "rgba(30, 41, 59, 0.4)".into(),
				tab_bg_active: "rgba(49, 62, 84, 0.65)".into(),
				tab_text_color: "#94a3b8".into(),
				tab_text_color_active: "#eef2ff".into(),
				tab_icon_color: "#64748b".into(),
				tab_icon_color_active: "#a5b4fc".into(),
				tab_border_color: "rgba(148, 163, 184, 0.24)".into(),
				window_control_btn_icon_color: "#94a3b8".into(),

				// 菜单 / 右键（几乎不透明，保证菜单可读）
				context_menu_bg: "rgba(30, 41, 59, 0.92)".into(),
				context_menu_border: "rgba(148, 163, 184, 0.28)".into(),
				context_menu_shadow: "rgba(2, 6, 23, 0.50)".into(),
				context_menu_item_text: "#e2e8f0".into(),
				context_menu_item_hover: "rgba(39, 52, 73, 0.7)".into(),
				context_menu_item_disabled: "#64748b".into(),

				// 侧边菜单（半透明玻璃侧栏）
				sidemenu_bg: "rgba(17, 28, 51, 0.5)".into(),
				menu_border_primary: "rgba(148, 163, 184, 0.24)".into(),
				sidemenu_text: "#94a3b8".into(),
				sidemenu_text_active: "#eef2ff".into(),

				// 滚动条 / 覆盖 / 分隔线
				scrollbar_track: "rgba(15, 23, 42, 0.3)".into(),
				scrollbar_thumb: "rgba(148, 163, 184, 0.4)".into(),
				scrollbar_thumb_hover: "rgba(148, 163, 184, 0.55)".into(),
				overlay: "rgba(2, 6, 23, 0.55)".into(),
				divider: "rgba(148, 163, 184, 0.2)".into(),

				// 交互状态
				selected_bg: "rgba(55, 48, 163, 0.75)".into(),
				selected_text: "#c7d2fe".into(),
				hover_bg: "rgba(39, 52, 73, 0.55)".into(),
				active_bg: "rgba(49, 46, 129, 0.7)".into(),

				// 阴影层级（毛玻璃场景阴影减轻）
				shadow_sm: "0 1px 2px rgba(2, 6, 23, 0.25)".into(),
				shadow_md: "0 14px 30px rgba(2, 6, 23, 0.20)".into(),
				shadow_lg: "0 24px 48px rgba(2, 6, 23, 0.26)".into(),
				shadow_xl: "0 36px 72px rgba(2, 6, 23, 0.30)".into(),

				// 可访问性与高对比
				high_contrast_text: "#ffffff".into(),

				// 面板
				panel_bg: "rgba(30, 41, 59, 0.5)".into(),
				panel_border: "rgba(148, 163, 184, 0.24)".into(),
			},
			built_in: true,
		};

		Self {
			auto_detect_system_theme: true,
			active_theme_id: "default-theme-dark".into(),
			themes: vec![light_theme, dark_theme, glass_theme],
			font_family: "Roboto".into(),
			font_size: 14,
			language: "zh-CN".into(),
			scrollbar_overlay: true,
			scrollbar_width: 10,
			ui_scale: 1.0,
			window_effect: "none".into(),
		}
	}
}

/// serde 字段默认值：ui_scale 是 f32，结构体级 #[serde(default)] 会兜底成 0.0
/// （0 倍缩放会让内容不可见），必须显式兜底为 1.0。
fn default_ui_scale() -> f32 {
	1.0
}

/// serde 字段默认值：窗口毛玻璃默认关闭（Acrylic 在部分 Windows 版本有拖拽卡顿问题）。
fn default_window_effect() -> String {
	"none".into()
}

/// serde 字段默认值：已存在 config.toml 缺字段时，serde 走字段类型 Default（bool→false、u32→0），
/// 需显式兜底，避免滚动条宽度归零（不可见）或覆盖式被关闭。
fn default_scrollbar_overlay() -> bool {
	true
}

fn default_scrollbar_width() -> u32 {
	10
}

impl Default for Terminal {
	fn default() -> Self {
		Self {
			active_theme_id: "default".into(),
			themes: builtin_terminal_themes(),
			font_family: "Consolas".into(),
			font_size: 14,
			line_height: 1.2,
			font_weight: 400,
			font_weight_bold: 600,
			cursor_style: CursorStyle::Block,
			cursor_blink: true,
			cursor_width: 2,
			scrollback: 1000,
			scroll_sensitivity: 1.0,
			fast_scroll_sensitivity: 5.0,
			background_opacity: 1.0,
			allow_transparent_background: false,
			draw_bold_text_in_bright_colors: true,
			background_image: "".into(),
			background_image_opacity: 0.7,
			background_image_blur: 0.0,
			extend_background_to_topbar: false,
			selection_opacity: 0.4,
			enable_bell: true,
			bell_style: BellStyle::None,
			right_click_selects_word: true,
			copy_on_select: true,
			scroll_on_input: true,
			legacy_color_scheme: ColorScheme::Default,
			auto_connect: true,
			render_engine: "dom".into(),
			gpu_acceleration: true,
		}
	}
}

/// 内置终端配色方案：default / solarized-dark / monokai / dracula / nord / one-dark / gruvbox-dark / termius。
fn builtin_terminal_themes() -> Vec<TerminalThemePreset> {
	fn theme(
		id: &str,
		name: &str,
		foreground: &str,
		background: &str,
		cursor: &str,
		cursor_accent: &str,
		selection: &str,
		ansi: [&str; 8],
		bright: [&str; 8],
	) -> TerminalThemePreset {
		TerminalThemePreset {
			id: id.into(),
			name: name.into(),
			colors: terminal_colors(foreground, background, cursor, cursor_accent, selection, ansi, bright),
			built_in: true,
		}
	}

	vec![
		// Swallow 默认（Indigo 深色，与应用深色主题一致）
		theme(
			"default",
			"Swallow 默认",
			"#e2e8f0", "#0f172a", "#818cf8", "#0f172a", "#334155",
			["#0f172a", "#f87171", "#34d399", "#fbbf24", "#818cf8", "#c084fc", "#22d3ee", "#e2e8f0"],
			["#475569", "#fca5a5", "#6ee7b7", "#fcd34d", "#a5b4fc", "#d8b4fe", "#67e8f9", "#f8fafc"],
		),
		// Solarized Dark
		theme(
			"solarized-dark",
			"Solarized Dark",
			"#839496", "#002b36", "#93a1a1", "#073642", "#073642",
			["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"],
			["#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
		),
		// Monokai
		theme(
			"monokai",
			"Monokai",
			"#f8f8f2", "#272822", "#f8f8f0", "#272822", "#49483e",
			["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2"],
			["#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"],
		),
		// Dracula
		theme(
			"dracula",
			"Dracula",
			"#f8f8f2", "#282a36", "#f8f8f2", "#282a36", "#44475a",
			["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"],
			["#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
		),
		// Nord
		theme(
			"nord",
			"Nord",
			"#d8dee9", "#2e3440", "#d8dee9", "#2e3440", "#4c566a",
			["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"],
			["#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
		),
		// Atom One Dark
		theme(
			"one-dark",
			"One Dark",
			"#abb2bf", "#282c34", "#528bff", "#282c34", "#3e4451",
			["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf"],
			["#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
		),
		// Gruvbox Dark
		theme(
			"gruvbox-dark",
			"Gruvbox Dark",
			"#ebdbb2", "#282828", "#ebdbb2", "#282828", "#504945",
			["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984"],
			["#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
		),
		// Termius（深色底 + 深绿，光标/高亮为 #0a9d58 深绿）
		theme(
			"termius",
			"Termius",
			"#b6efc9", "#10161f", "#0a9d58", "#10161f", "#123f2a",
			["#10161f", "#ff5f57", "#0a9d58", "#f3f99d", "#5ac8fa", "#ff7eb6", "#64d8cb", "#c4f2d4"],
			["#5c6b7d", "#ff6b66", "#17c46f", "#fbffb1", "#7fd4ff", "#ff9acb", "#7ff5e4", "#e4fff0"],
		),
		// 绿洲（Oasis Green）：深墨绿底 + 翠绿主色，护眼高对比，辅助色柔和与绿协调
		theme(
			"oasis-green",
			"绿洲 (Oasis)",
			"#d1e7dd", "#0d2017", "#4ade80", "#0d2017", "#1e4532",
			["#0d2017", "#ef6a73", "#34d399", "#e5c07b", "#7cb8f7", "#c792ea", "#5fd4d0", "#c4dccd"],
			["#4d6b5c", "#ff8b92", "#5fe8b8", "#ffd9a0", "#9acfff", "#dfaeff", "#8cf0ec", "#eefaf2"],
		),
	]
}

fn terminal_colors(
	foreground: &str,
	background: &str,
	cursor: &str,
	cursor_accent: &str,
	selection: &str,
	ansi: [&str; 8],
	bright: [&str; 8],
) -> TerminalThemeColors {
	TerminalThemeColors {
		black: ansi[0].into(),
		red: ansi[1].into(),
		green: ansi[2].into(),
		yellow: ansi[3].into(),
		blue: ansi[4].into(),
		magenta: ansi[5].into(),
		cyan: ansi[6].into(),
		white: ansi[7].into(),
		bright_black: bright[0].into(),
		bright_red: bright[1].into(),
		bright_green: bright[2].into(),
		bright_yellow: bright[3].into(),
		bright_blue: bright[4].into(),
		bright_magenta: bright[5].into(),
		bright_cyan: bright[6].into(),
		bright_white: bright[7].into(),
		foreground: foreground.into(),
		background: background.into(),
		cursor: cursor.into(),
		cursor_accent: cursor_accent.into(),
		selection: selection.into(),
	}
}

/// serde 字段默认值：已存在 config.toml 缺字段时，serde 走字段类型 Default（f32→0.0），
/// 需显式兜底，避免背景图默认透明不可见。
fn default_background_image_opacity() -> f32 {
	0.7
}

fn default_background_image_blur() -> f32 {
	0.0
}

fn default_selection_opacity() -> f32 {
	0.4
}

fn default_render_engine() -> String {
	"dom".into()
}

fn default_gpu_acceleration() -> bool {
	true
}

impl Default for SshSettings {
	fn default() -> Self {
		Self {
			connection_timeout: 30,
			keep_alive_interval: 60,
			auto_reconnect: true,
			max_reconnect_attempts: 3,
			default_port: 22,
			compression: true,
		}
	}
}

impl Default for ShortcutBinding {
	fn default() -> Self {
		Self {
			new_tab: "Ctrl+T".into(),
			close_tab: "Ctrl+W".into(),
			next_tab: "Ctrl+Shift+→".into(),
			prev_tab: "Ctrl+Shift+←".into(),
			copy: "Ctrl+C".into(),
			paste: "Ctrl+V".into(),
			find: "Ctrl+F".into(),
			terminal_copy: "Ctrl+Shift+C".into(),
			terminal_paste: "Ctrl+Shift+V".into(),
			terminal_select_all: "Ctrl+Shift+A".into(),
			enabled: true,
		}
	}
}

impl Default for Security {
	fn default() -> Self {
		Self {
			encrypt_passwords: true,
			session_timeout: 30,
			lock_on_suspend: false,
			clear_clipboard_after: 60,
		}
	}
}

impl Default for Advanced {
	fn default() -> Self {
		Self {
			auto_save: false,
			// 恢复上次会话默认开启（App.tsx 读取此开关；老配置缺字段时走这里，保持既有行为）
			restore_sessions: true,
			confirm_on_close: false,
			minimize_to_tray: false,
			max_logs: 1000,
			enable_debug_log: false,
			debug_mode: false,
			check_updates: true,
			send_analytics: false,
		}
	}
}

impl Default for ThemeColors {
	fn default() -> Self {
		Self {
			// 主题色（现代靛蓝 Indigo）
			primary: "#818cf8".into(),
			primary_light: "#a5b4fc".into(),
			primary_dark: "#6366f1".into(),

			// 语义色
			success: "#34d399".into(),
			warning: "#fbbf24".into(),
			error: "#f87171".into(),
			info: "#22d3ee".into(),

			// 文本色
			text_primary: "#eef2ff".into(),
			text_muted: "#94a3b8".into(),
			text_secondary: "#cbd5e1".into(),
			text_tertiary: "#64748b".into(),
			text_disabled: "#475569".into(),
			text_placeholder: "#64748b".into(),
			text_link: "#a5b4fc".into(),

			// 表面层
			bg_primary: "#0f172a".into(),
			surface: "#1e293b".into(),
			surface_elevated: "#273449".into(),

			// 按钮
			btn_primary_bg: "#818cf8".into(),
			btn_primary_text: "#1e1b4b".into(),
			btn_primary_hover: "#a5b4fc".into(),
			btn_secondary_bg: "#273449".into(),
			btn_secondary_text: "#e2e8f0".into(),
			btn_danger_bg: "#e11d48".into(),
			btn_danger_text: "#ffffff".into(),

			// 控件 / 边框 / 输入
			border_primary: "#334155".into(),
			border_focus: "#818cf8".into(),
			input_bg: "#1e293b".into(),
			input_text: "#eef2ff".into(),
			input_placeholder: "#64748b".into(),
			control_disabled_bg: "#1e293b".into(),
			control_disabled_text: "#64748b".into(),
			focus_ring: "#818cf8".into(),

			// 顶部栏与标签
			topbar_bg: "#0f172a".into(),
			tab_bg: "#1e293b".into(),
			tab_bg_active: "#273449".into(),
			tab_text_color: "#94a3b8".into(),
			tab_text_color_active: "#eef2ff".into(),
			tab_icon_color: "#64748b".into(),
			tab_icon_color_active: "#a5b4fc".into(),
			tab_border_color: "#334155".into(),
			window_control_btn_icon_color: "#94a3b8".into(),

			// 菜单 / 右键
			context_menu_bg: "#1e293b".into(),
			context_menu_border: "#334155".into(),
			context_menu_shadow: "rgba(2, 6, 23, 0.50)".into(),
			context_menu_item_text: "#e2e8f0".into(),
			context_menu_item_hover: "#273449".into(),
			context_menu_item_disabled: "#64748b".into(),

			// 侧边菜单
			sidemenu_bg: "#111c33".into(),
			menu_border_primary: "#334155".into(),
			sidemenu_text: "#94a3b8".into(),
			sidemenu_text_active: "#eef2ff".into(),

			// 滚动条 / 覆盖 / 分隔线
			scrollbar_track: "#0f172a".into(),
			scrollbar_thumb: "#334155".into(),
			scrollbar_thumb_hover: "#475569".into(),
			overlay: "rgba(2, 6, 23, 0.72)".into(),
			divider: "#334155".into(),

			// 交互状态
			selected_bg: "#3730a3".into(),
			selected_text: "#c7d2fe".into(),
			hover_bg: "#273449".into(),
			active_bg: "#312e81".into(),

			// 阴影层级
			shadow_sm: "0 1px 2px rgba(2, 6, 23, 0.34)".into(),
			shadow_md: "0 14px 30px rgba(2, 6, 23, 0.28)".into(),
			shadow_lg: "0 24px 48px rgba(2, 6, 23, 0.36)".into(),
			shadow_xl: "0 36px 72px rgba(2, 6, 23, 0.42)".into(),

			// 可访问性与高对比
			high_contrast_text: "#ffffff".into(),

			// 面板
			panel_bg: "#1e293b".into(),
			panel_border: "#334155".into(),
		}
	}
}
