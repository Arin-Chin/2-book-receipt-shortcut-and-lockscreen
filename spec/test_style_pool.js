// spec/test_style_pool.js — v2.6.0 「勾选池 + 摘要显示模式」逻辑自检
// 用 fengari 加载真实补丁源码（mock KOReader 依赖），断言样式池/迁移/轮换行为。
// 运行：npm i fengari  然后  node spec/test_style_pool.js
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const patchPath = path.join(__dirname, '..', '2-book-receipt-shortcut-and-lockscreen.lua');
const src = fs.readFileSync(patchPath, 'utf8');
if (src.includes(']==]')) throw new Error('long-bracket delimiter collision');

const prelude = `
__gesture_actions = {}
__log_lines = {}
local function __record(_, ...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    __log_lines[#__log_lines + 1] = table.concat(parts, " ")
end
__screensaver_stub = { show = function() end }
-- 可观测的 UIManager：能记录 setDirty 调用（验证唤醒刷新计数诊断），其余方法仍为 no-op
__setdirty_calls = {}
__uimanager_stub = setmetatable({
    setDirty = function(_, widget, mode)
        __setdirty_calls[#__setdirty_calls + 1] = tostring(widget) .. "/" .. tostring(mode)
    end,
    scheduleIn = function() end,
    unschedule = function() end,
}, { __index = function() return function() end end })
-- 假的 screensaver_menu.lua 结果，让补丁的 dofile 钩子真的跑一遍注入逻辑（菜单代码不在沙箱默认路径上）
__fake_screensaver_menu = { { text = "Wallpaper", sub_item_table = {
    { text = "(dummy1)" }, { text = "(dummy2)" }, { text = "(dummy3)" }, { text = "(dummy4)" }, { text = "(dummy5)" },
} } }
dofile = function(path)
    if type(path) == "string" and path:match("screensaver_menu%.lua$") then return __fake_screensaver_menu end
end
local store = { book_receipt_dev_test = true }
G_reader_settings = {
    _s = store,
    saveSetting = function(self, k, v) store[k] = v end,
    readSetting = function(self, k) return store[k] end,
    delSetting = function(self, k) store[k] = nil end,
    has = function(self, k) return store[k] ~= nil end,
    isTrue = function(self, k) return store[k] == true end,
    isFalse = function(self, k) return store[k] == false end,
}
local function generic_stub()
    local t = {}
    setmetatable(t, { __index = function() return function() return t end end })
    return t
end
local screen = {
    getSize = function() return { w = 600, h = 800 } end,
    getWidth = function() return 600 end,
    getHeight = function() return 800 end,
    getDPI = function() return 300 end,
    scaleBySize = function(_, n) return n end,
    getRotationMode = function() return 0 end,
    DEVICE_ROTATED_UPRIGHT = 0,
    bb = {},
}
local function simple_class(base)
    base = base or {}
    function base:extend(o)
        o = o or {}
        return setmetatable(o, { __index = self })
    end
    function base:new(o)
        o = self:extend(o)
        if o.init then o:init() end
        return o
    end
    return base
end
local stubs = {
    ["device"] = setmetatable({ screen = screen }, { __index = function() return function() end end }),
    ["ffi/util"] = { template = function(s) return s end },
    ["bit"] = { band = function() return 0 end, bor = function() return 0 end },
    ["gettext"] = function(s) return s end,
    ["logger"] = { info = __record, warn = __record, dbg = __record },
    ["ui/screensaver"] = __screensaver_stub,
    ["ui/uimanager"] = __uimanager_stub,
    ["dispatcher"] = { registerAction = function(_, id, o) __gesture_actions[id] = o end },
    ["fontlist"] = { fontdir = "/tmp/fonts" },
    ["datastorage"] = { getSettingsDir=function() return "/tmp" end, getDataDir=function() return "/tmp" end },
    ["libs/libkoreader-lfs"] = { attributes = function() return nil end },
    ["util"] = { findFiles=function() end, stringStartsWith=function() return false end, trim=function(s) return s end, splitToArray=function() return {} end, arrayAppend=function() end },
    ["document/documentregistry"] = { isImageFile=function() return false end },
    ["ffi/blitbuffer"] = { COLOR_WHITE=0, COLOR_BLACK=1, COLOR_GRAY_B=2, Color8=function(v) return v end, new=function() return { fill=function() end, getType=function() return 0 end } end },
    ["ui/font"] = { getFace=function() return { getHeight=function() return 10 end } end },
    ["ui/geometry"] = { new=function(_, o) return o end },
    ["ui/rendertext"] = {
        sizeUtf8Text = function(_, _, _, _, s) return { x = #tostring(s) * 8 } end,
        renderUtf8Text = function() end,
    },
    ["ui/widget/container/inputcontainer"] = simple_class(),
    ["ui/widget/iconwidget"] = {
        new = function(_, _) return { paintTo = function() end, free = function() end } end,
    },
}
_G.require = function(name)
    local v = stubs[name]
    if v ~= nil then return v end
    return generic_stub()
end
local SRC = [==[
${src}
]==]
_G.__patch_ok, _G.__patch_err = pcall(function()
    local fn = load(SRC, "patch")
    if not fn then error("compile failed") end
    return fn()
end)
`;

const bootstrap = `
${prelude}
assert(__patch_ok, "patch load failed: " .. tostring(__patch_err))
local t = _G._book_receipt_style_test
assert(t, "test hook missing")
local G = G_reader_settings
local function reset()
    for k in pairs(G._s) do G._s[k] = nil end
    G._s.book_receipt_dev_test = true
end
local film, ink, menu, image = "film", "inkstain", "menu", "image"

-- 全新安装：仅胶片票根在池内（等价旧版 fixed film）
reset()
assert(t.normalizeReceiptStyle(nil) == film)
assert(#t.getEnabledStyles() == 1 and t.getEnabledStyles()[1] == film, "fresh -> film only")
assert(t.getStyleMode() == "random", "fresh mode random")
for i = 1, 20 do assert(t.getEffectiveStyle() == film, "fresh fixed film") end

-- 旧配置迁移：random/alternate -> 全选；fixed -> 仅该样式
reset(); G._s.book_receipt_style_mode = "random"
assert(#t.getEnabledStyles() == 4, "legacy random -> all")
reset(); G._s.book_receipt_style_mode = "alternate"
assert(#t.getEnabledStyles() == 4, "legacy alternate -> all")
reset(); G._s.book_receipt_style_mode = "fixed"; G._s.book_receipt_style = "inkstain"
assert(#t.getEnabledStyles() == 1 and t.getEnabledStyles()[1] == ink, "legacy fixed -> inkstain")

-- 显式取消勾选优先于旧配置回退
reset(); G._s.book_receipt_style_mode = "random"; G._s.book_receipt_film_enabled = false
local pool = t.getEnabledStyles()
assert(#pool == 3 and pool[1] == ink and pool[2] == menu and pool[3] == image, "uncheck film from legacy random")

-- 全部取消勾选 -> 回退胶片票根
reset(); G._s.book_receipt_film_enabled = false; G._s.book_receipt_inkstain_enabled = false; G._s.book_receipt_menu_enabled = false
assert(#t.getEnabledStyles() == 1 and t.getEnabledStyles()[1] == film, "all unchecked -> film fallback")

-- 轮流模式只在已勾选池内循环（跳过未勾选的 film）：ink → menu → image → ink
reset(); G._s.book_receipt_style_mode = "alternate"
G._s.book_receipt_film_enabled = false
local seen = {}
for i = 1, 5 do seen[i] = t.getEffectiveStyle() end
assert(seen[1] == ink and seen[2] == menu and seen[3] == image and seen[4] == ink and seen[5] == menu,
    "alternate cycles checked pool, got " .. table.concat(seen, ","))

-- 随机模式绝不返回未勾选样式
reset(); G._s.book_receipt_style_mode = "random"; G._s.book_receipt_film_enabled = false
for i = 1, 50 do
    local s = t.getEffectiveStyle()
    assert(s ~= film, "random leaked disabled film")
end

-- 日票渲染冒烟：buildFilmReceipt -> Receipt:paintTo 走通真实绘制路径（防改名/漏变量）
reset()
local fake_ui = {
    document = {
        file = "/tmp/demo.epub",
        getProps = function() return { title = "测试书籍", authors = "测试作者" } end,
        getPageCount = function() return 100 end,
    },
    view = { state = { page = 5 } },
    doc_settings = {
        readSetting = function(_, k)
            if k == "summary" then return { status = "reading", rating = 3 } end
        end,
    },
}
local widget = t.buildFilmReceipt(fake_ui, nil)
assert(widget, "buildFilmReceipt returned nil")
assert(type(widget.getSize) == "function", "widget missing getSize")
assert(type(widget.paintTo) == "function", "widget missing paintTo")
local paints = 0
local bb = {
    paintRect = function() paints = paints + 1 end,
    blitFrom = function() end,
}
local ok_render, err_render = pcall(function() widget:paintTo(bb, 0, 0) end)
assert(ok_render, "Receipt:paintTo failed: " .. tostring(err_render))
assert(paints > 500, "Receipt:paintTo drew too little: " .. paints)
print("READ RECEIPT RENDER SMOKE PASSED (" .. paints .. " paintRect)")

-- 手势动作注册（v2.7.2）：两个动作各自 event / 标题（标题走内嵌汉化表）
local actions = __gesture_actions
assert(actions.quicklookbox_action, "quicklookbox_action not registered")
assert(actions.quicklookbox_action.event == "QuickLook", "book receipt event mismatch")
assert(actions.quicklookbox_action.title == "Book-RL：阅读摘要",
    "book receipt title mismatch: " .. tostring(actions.quicklookbox_action.title))
assert(actions.reading_ticket_action, "reading_ticket_action not registered")
assert(actions.reading_ticket_action.event == "ShowReadingTicket", "reading ticket event mismatch")
assert(actions.reading_ticket_action.title == "Book-RL：阅读日票",
    "reading ticket title mismatch: " .. tostring(actions.reading_ticket_action.title))
assert(actions.reading_ticket_action.event ~= actions.quicklookbox_action.event,
    "both gestures share one event -> one gesture would fire both actions")
print("GESTURE ACTIONS PASSED (" .. actions.quicklookbox_action.title .. " / "
    .. actions.reading_ticket_action.title .. ")")

-- 锁屏底色兜底（v2.7.3/v2.7.8）：底图没铺满屏幕时（居中不缩放、留边、取图失败）也必须有不透明底色，
-- 否则票面与底图之外就是屏幕原内容（当前阅读页）；颜色默认白，尊重 KOReader 自己的「边框填充」设置
assert(t.resolveScreensaverBackground, "resolveScreensaverBackground missing")
assert(t.resolveScreensaverBackground(nil) == 0, "no explicit fill must fall back to opaque white")
assert(t.resolveScreensaverBackground(1) == 1, "explicit fill must be preserved")
G._s.screensaver_img_background = "black"
assert(t.resolveScreensaverBackground(nil) == 1, "KOReader's 'Border fill: black' must be honored")
G._s.screensaver_img_background = nil
print("SCREENSAVER BACKGROUND FALLBACK PASSED")


-- 内容库惰性化（v2.7.4）：诗词不再在加载期解析；顺手断言内嵌文本仍可解析、条数不缩水、自带缓存
assert(t.parsePoemText and t.parseRecipeText and t.parseQuotationText, "content parsers missing from dev hook")
local poems = t.parsePoemText()
local quotations = t.parseQuotationText()
local recipes = t.parseRecipeText()
local recipe_total = 0
for _, pool in pairs(recipes) do recipe_total = recipe_total + #pool end
assert(#poems >= 200, "poems parsed: " .. #poems)
assert(#quotations >= 200, "quotations parsed: " .. #quotations)
assert(recipe_total >= 250, "recipes parsed: " .. recipe_total)
assert(poems[1] and poems[1].text and poems[1].author, "poem item missing fields")
assert(quotations[1] and quotations[1].quote and quotations[1].person, "quotation item missing fields")
assert(t.parsePoemText() == poems, "parsePoemText lost its cache (re-parsed on every call)")
assert(t.parseRecipeText() == recipes, "parseRecipeText lost its cache")
print("LAZY CONTENT LIBRARY PASSED (" .. #poems .. " 诗词 / " .. recipe_total .. " 菜谱 / " .. #quotations .. " 名言)")

-- 菜单注入：跑一遗补丁的 dofile 钩子，确认菜单项真的注入了 阅读摘要设置（含样式项/设备栏）
local injected = dofile("screensaver_menu.lua")
assert(injected and injected[1] and injected[1].sub_item_table, "menu injection did not run")
local wallpaper = injected[1].sub_item_table
local settings_item, sleep_item
for _, item in ipairs(wallpaper) do
    if item.text == "阅读摘要设置" then settings_item = item end
    if item.text == "在休眠屏幕显示阅读摘要" then sleep_item = item end
end
assert(sleep_item, "sleep-screen radio item not injected")
assert(settings_item, "Book receipt settings item not injected")
local subs = {}
for _, sub in ipairs(settings_item.sub_item_table) do
    subs[#subs + 1] = tostring(sub.text or (sub.text_func and sub.text_func()))
end
-- 阅读日票子菜单（v2.7.11）：原版胶片遗留、对日票无效的两项（内容 / 设置休眠状态显示文字）已删，
-- 背景 改名 锁屏背景；保留 封面缩放
local film_item
for _, sub in ipairs(settings_item.sub_item_table) do
    if sub.text == "阅读日票" then film_item = sub end
end
assert(film_item and film_item.sub_item_table, "film style menu missing")
local film_subs = {}
for _, sub in ipairs(film_item.sub_item_table) do film_subs[#film_subs + 1] = tostring(sub.text) end
assert(table.concat(film_subs, " | ") == "锁屏背景 | 封面缩放",
    "film submenu must be 锁屏背景 | 封面缩放, got: " .. table.concat(film_subs, " | "))
-- 第四种样式「随机图片」（v2.7.15）：紧跟「菜单留单台」，带勾选框 + 共用的背景图片显示方式
local menu_style_index, image_item
for i, sub in ipairs(settings_item.sub_item_table) do
    if sub.text == "菜单留单台" then menu_style_index = i end
    if sub.text == "随机图片" then image_item = sub end
end
assert(image_item, "random-image style menu item missing")
assert(image_item.sub_item_table and #image_item.sub_item_table == 1,
    "random-image style must expose the shared placement setting")
assert(image_item.sub_item_table[1].text == "背景图片显示方式", "random-image style placement label mismatch")
assert(settings_item.sub_item_table[menu_style_index + 1] == image_item,
    "random-image item must sit right below 菜单留单台")
-- 墨痕壁纸：设备栏已上移到本级（v2.7.13），紧跟「摘要显示模式」，且可自定义（v2.7.12）
-- 菜单那一行的 text_func 会跟着变，且可点进去编辑
assert(t.getDeviceInfoString, "getDeviceInfoString missing from dev hook")
local parent_items = settings_item.sub_item_table
local device_row, device_index, inkstain_item
for i, sub in ipairs(parent_items) do
    if type(sub.text_func) == "function" then device_row = sub; device_index = i end
    if sub.text == "墨痕壁纸" then inkstain_item = sub end
end
assert(device_row and type(device_row.callback) == "function", "device row must be a tappable parent-level item")
assert(parent_items[device_index - 1].text == "摘要显示模式",
    "device row must sit right below 摘要显示模式, got: " .. tostring(parent_items[device_index - 1].text))
-- 样式项长按整行 = 勾选/取消（v2.7.16）
assert(type(film_item.hold_callback) == "function", "film item must support long-press toggle")
assert(type(image_item.hold_callback) == "function", "image item must support long-press toggle")
reset()
assert(t.isStyleEnabled("film") == true and t.isStyleEnabled("image") == false, "fresh: only film enabled")
local fake_menu = { updateItems = function() end }
image_item.hold_callback(fake_menu)
assert(t.isStyleEnabled("image") == true, "long-press must toggle the image style on")
image_item.hold_callback(fake_menu)
assert(t.isStyleEnabled("image") == false, "long-press must toggle the image style off again")
-- 墨痕壁纸子菜单里不再有设备栏（只剩统计周期 / 书单数量）
assert(inkstain_item and inkstain_item.sub_item_table, "ink stain menu missing")
local ink_subs = {}
for _, sub in ipairs(inkstain_item.sub_item_table) do ink_subs[#ink_subs + 1] = tostring(sub.text) end
assert(table.concat(ink_subs, " | ") == "统计周期 | 书单数量",
    "inkstain submenu must be 统计周期 | 书单数量, got: " .. table.concat(ink_subs, " | "))
-- 自定义优先于自动（自定义时提前返回，不碰 Device，沙箱里也稳定）
reset()
G._s.book_receipt_device_text = "我的电纸书"
assert(t.getDeviceInfoString("设备：") == "设备：我的电纸书", "custom device text must replace the auto string")
assert(t.getDeviceInfoString("点单设备：") == "点单设备：我的电纸书", "custom device text must keep the caller's prefix")
assert(device_row.text_func() == "设备信息：我的电纸书", "menu row must show 设备信息： prefix + custom text")
G._s.book_receipt_device_text = nil
print("DEVICE ROW CUSTOM TEXT PASSED")

-- 居中模式的可见性兑底（v2.7.13）：铺不满屏幕或过大 → 改用适应屏幕
assert(t.shouldAdaptCenteredBackground, "shouldAdaptCenteredBackground missing")
assert(t.shouldAdaptCenteredBackground(600, 800, 1072, 1448) == true, "smaller-than-screen image must be adapted")
assert(t.shouldAdaptCenteredBackground(800, 2000, 1072, 1448) == true, "narrower-than-screen image must be adapted")
assert(t.shouldAdaptCenteredBackground(1500, 2000, 1072, 1448) == false, "image covering the screen may keep 1:1")
assert(t.shouldAdaptCenteredBackground(3000, 2000, 1072, 1448) == true, "oversized image must be adapted (memory guard)")
print("CENTERED BACKGROUND FALLBACK PASSED")
print("MENU INJECTION PASSED (" .. table.concat(subs, " | ") .. "; film: " .. table.concat(film_subs, " | ") .. ")")

-- 唤醒刷新计数诊断（v2.7.14）：窗口内每笔 setDirty 都被计数，收尾打一行 info 汇总（两台设备对比用）
assert(t.wakeDiagFinish, "wakeDiagFinish missing")
reset()
__setdirty_calls = {}
__screensaver_stub:close() -- 诊断窗口默认就开（与任何开关无关）
__uimanager_stub:setDirty(nil, "full")
__uimanager_stub:setDirty("all", "full")
__uimanager_stub:setDirty("bookshelf", "full")
__uimanager_stub:setDirty("ReaderUI", "partial")
__log_lines = {}
t.wakeDiagFinish()
local summary
for _, line in ipairs(__log_lines) do
    if line:find("唤醒刷新计数") then summary = line end
end
assert(summary, "wake refresh summary log missing")
assert(summary:find("n=4") and summary:find("nil/full") and summary:find("bookshelf/full"),
    "wake refresh summary must list all sources: " .. summary)
print("WAKE REFRESH COUNTER PASSED (" .. summary:gsub("^.-\uff1a", "") .. ")")

print("STYLE POOL TESTS PASSED")
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
const status = lauxlib.luaL_dostring(L, to_luastring(bootstrap));
if (status !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1));
    console.error('ERROR:', msg);
    const ln = parseInt((msg.match(/:([0-9]+):/) || [])[1] || '0');
    const lines = bootstrap.split('\n');
    for (let i = ln - 4; i < ln + 2; i++) console.error((i + 1) + '| ' + (lines[i] || ''));
    process.exit(1);
}
