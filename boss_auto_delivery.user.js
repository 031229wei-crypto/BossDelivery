// ==UserScript==
// @name         BOSS直聘自动投递助手
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自动投递简历到BOSS直聘，支持岗位筛选、自动投递
// @author       User
// @match        https://www.zhipin.com/*
// @match        https://www.zhipin.com/web/geek/job*
// @icon         https://www.zhipin.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.openai.com
// @connect      api.doubao.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置项 ====================
    const CONFIG = {
        ai: {
            apiKey: GM_getValue('ai_api_key', ''),
            apiUrl: GM_getValue('ai_api_url', 'https://api.openai.com/v1/chat/completions'),
            model: GM_getValue('ai_model', 'gpt-3.5-turbo'),
            enabled: GM_getValue('ai_enabled', false)
        },
        jobFilter: {
            keywords: GM_getValue('job_keywords', ['前端', 'JavaScript', 'Vue', 'React']),
            minSalary: GM_getValue('min_salary', 10),
            maxSalary: GM_getValue('max_salary', 30),
            excludeKeywords: GM_getValue('exclude_keywords', ['外包', '驻场', '劳务派遣'])
        },
        delivery: {
            interval: GM_getValue('delivery_interval', 30000),
            randomDelay: GM_getValue('random_delay', true),
            maxDaily: GM_getValue('max_daily', 50),
            skipDelivered: GM_getValue('skip_delivered', true)
        },
        resume: {
            baseContent: GM_getValue('resume_content', '')
        }
    };

    // 状态管理
    const STATE = {
        isRunning: false,
        deliveredCount: 0,
        todayDelivered: GM_getValue('today_delivered', 0),
        lastDeliveryDate: GM_getValue('last_delivery_date', ''),
        currentJob: null
    };

    // ==================== 工具函数 ====================

    function log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[BOSS助手] ${timestamp} ${message}`);
        updateLogPanel(`[${timestamp}] ${message}`, type);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getRandomDelay() {
        if (!CONFIG.delivery.randomDelay) return CONFIG.delivery.interval;
        return CONFIG.delivery.interval + (Math.random() * 10000 - 5000);
    }

    // ==================== 岗位匹配 ====================

    function parseSalary(salaryStr) {
        const match = salaryStr.match(/(\d+)-(\d+)K?/i);
        return match ? { min: parseInt(match[1]), max: parseInt(match[2]) } : { min: 0, max: 999 };
    }

    function isJobMatched(jobInfo) {
        const { title, company } = jobInfo;
        const filter = CONFIG.jobFilter;

        if (!title) return false;

        // 排除关键词
        for (const kw of filter.excludeKeywords) {
            if (title.includes(kw) || (company && company.includes(kw))) {
                log(`排除: ${title} (含"${kw}")`, 'warn');
                return false;
            }
        }

        // 关键词匹配 - 如果没设置关键词则全部通过
        if (filter.keywords.length > 0) {
            const hasKeyword = filter.keywords.some(kw => title.toLowerCase().includes(kw.toLowerCase()));
            if (!hasKeyword) {
                log(`不匹配: ${title}`, 'warn');
                return false;
            }
        }

        return true;
    }

    // ==================== DOM操作 ====================

    function getJobListElements() {
        // BOSS直聘岗位列表选择器（多种可能）
        const selectors = [
            // 新版页面结构
            '.job-list-box li',
            '.job-list-box .job-card-wrapper',
            '.job-card-wrapper',
            // 搜索结果页
            '[ka="search-job-item"]',
            '.search-job-result li',
            '.job-list li',
            // 岗位卡片
            '.job-card-left',
            '.job-card',
            // 通用选择器
            'li[class*="job"]',
            'div[class*="job-card"]'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                log(`找到 ${elements.length} 个岗位 (${selector})`);
                return Array.from(elements);
            }
        }

        // 尝试更通用的方式
        const allLinks = document.querySelectorAll('a[href*="/job_detail/"]');
        if (allLinks.length > 0) {
            const jobCards = new Set();
            allLinks.forEach(link => {
                const card = link.closest('li') || link.closest('[class*="card"]') || link.parentElement;
                if (card) jobCards.add(card);
            });
            if (jobCards.size > 0) {
                log(`找到 ${jobCards.size} 个岗位 (通过链接查找)`);
                return Array.from(jobCards);
            }
        }

        log('未找到岗位，请确认在岗位列表页面', 'error');
        return [];
    }

    function extractJobInfo(jobElement) {
        try {
            // 岗位名称 - 尝试多种选择器
            let title = '';
            const titleSelectors = [
                '.job-name',
                '.job-title',
                '.job-name-text',
                '.job-info .name',
                'span[class*="job-name"]',
                'a[href*="/job_detail/"] .name'
            ];

            for (const sel of titleSelectors) {
                const el = jobElement.querySelector(sel);
                if (el && el.textContent.trim()) {
                    title = el.textContent.trim();
                    break;
                }
            }

            // 如果还没找到，从链接获取
            if (!title) {
                const linkEl = jobElement.querySelector('a[href*="/job_detail/"]');
                if (linkEl) {
                    // 只取链接的第一个文本节点
                    title = linkEl.childNodes[0]?.textContent?.trim() || linkEl.textContent.trim().split(/[\n\r@]/)[0];
                }
            }

            // 清理标题
            title = title.replace(/^["\s]+|["\s]+$/g, '').split('@')[0].trim();

            // 薪资
            let salary = '';
            const salaryEl = jobElement.querySelector('.salary, .job-salary, span[class*="salary"]');
            if (salaryEl) {
                salary = salaryEl.textContent.trim();
            }

            // 公司名
            let company = '';
            const companyEl = jobElement.querySelector('.company-name, .company-text, a[href*="/gongsi/"], span[class*="company"]');
            if (companyEl) {
                company = companyEl.textContent.trim().split(/[\n\r@]/)[0];
            }

            // 链接
            const linkEl = jobElement.querySelector('a[href*="/job_detail/"]');
            const jobUrl = linkEl ? linkEl.href : '';

            return { title, salary, company, jobUrl, element: jobElement };
        } catch (e) {
            return null;
        }
    }

    function isAlreadyDelivered(jobElement) {
        // 检查多种已投递标识
        const text = jobElement.textContent || '';
        if (text.includes('已沟通') || text.includes('已投递') || text.includes('已聊过')) {
            return true;
        }

        const badge = jobElement.querySelector('.job-status, .delivered, [class*="status"], [class*="chat-status"]');
        if (badge && (badge.textContent.includes('已') || badge.textContent.includes('聊'))) {
            return true;
        }
        return false;
    }

    async function clickDeliveryButton(jobElement) {
        try {
            // 1. 直接定位（不用smooth滚动，避免触发加载更多）
            jobElement.scrollIntoView({ block: 'center' });
            await sleep(500);

            // 2. 点击岗位链接选中它
            const linkEl = jobElement.querySelector('a[href*="/job_detail/"]') || jobElement.querySelector('a') || jobElement;
            linkEl.click();
            await sleep(1200); // 等待右侧加载

            // 3. 在全局查找"立即沟通"按钮
            const allBtns = document.querySelectorAll('button, [role="button"], [class*="btn"], a');

            for (const btn of allBtns) {
                const text = btn.textContent.trim();
                if (text === '立即沟通') {
                    btn.scrollIntoView({ block: 'center' });
                    await sleep(300);
                    btn.click();
                    log('点击: 立即沟通');

                    // 处理弹窗
                    await sleep(500);
                    await handlePopup();

                    return true;
                }
            }

            log('未找到沟通按钮', 'warn');
            return false;
        } catch (e) {
            log('点击失败: ' + e.message, 'error');
            return false;
        }
    }

    // 处理弹窗
    async function handlePopup() {
        // 查找弹窗中的"留在此页"按钮
        const popupSelectors = [
            '.dialog-content',
            '.modal-content',
            '[class*="dialog"]',
            '[class*="modal"]',
            '[class*="popup"]'
        ];

        for (const sel of popupSelectors) {
            const popup = document.querySelector(sel);
            if (popup && popup.offsetParent !== null) {
                const btns = popup.querySelectorAll('button, [class*="btn"], a');
                for (const btn of btns) {
                    const text = btn.textContent.trim();
                    if (text.includes('留在此页') || text === '留在此页') {
                        await sleep(200);
                        btn.click();
                        log('点击: 留在此页');
                        return true;
                    }
                }
            }
        }

        // 全局搜索
        const allBtns = document.querySelectorAll('button, [class*="btn"], a');
        for (const btn of allBtns) {
            const text = btn.textContent.trim();
            if (text === '留在此页') {
                await sleep(200);
                btn.click();
                log('点击: 留在此页');
                return true;
            }
        }

        return false;
    }

    // ==================== 主逻辑 ====================

    function checkDailyLimit() {
        const today = new Date().toDateString();
        if (STATE.lastDeliveryDate !== today) {
            STATE.todayDelivered = 0;
            STATE.lastDeliveryDate = today;
            GM_setValue('last_delivery_date', today);
            GM_setValue('today_delivered', 0);
        }
        return STATE.todayDelivered < CONFIG.delivery.maxDaily;
    }

    async function deliverJob(jobInfo) {
        if (!STATE.isRunning) return;

        STATE.currentJob = jobInfo.title;
        updateStatus();

        if (CONFIG.delivery.skipDelivered && isAlreadyDelivered(jobInfo.element)) {
            log(`跳过已投递: ${jobInfo.title}`, 'warn');
            return;
        }

        const success = await clickDeliveryButton(jobInfo.element);

        if (success) {
            STATE.deliveredCount++;
            STATE.todayDelivered++;
            GM_setValue('today_delivered', STATE.todayDelivered);
            log(`投递成功: ${jobInfo.title} @ ${jobInfo.company}`);

            GM_notification({
                title: '投递成功',
                text: `${jobInfo.title} - ${jobInfo.company}`,
                timeout: 2000
            });
        }

        STATE.currentJob = null;
        updateStatus();
    }

    async function runAutoDelivery() {
        if (STATE.isRunning) return;

        STATE.isRunning = true;
        STATE.deliveredCount = 0;
        updateStatus();
        log('开始自动投递');

        if (!checkDailyLimit()) {
            log('今日已达上限', 'warn');
            STATE.isRunning = false;
            updateStatus();
            return;
        }

        // 记录已处理的岗位ID
        const processedJobs = new Set();

        // 先获取一次岗位列表
        let jobElements = getJobListElements();
        let currentIndex = 0;
        let noNewCount = 0; // 连续没有新岗位的次数

        while (STATE.isRunning && checkDailyLimit()) {
            // 如果当前索引超出列表，尝试获取更多
            if (currentIndex >= jobElements.length) {
                // 滚动到底部加载更多
                const lastJob = jobElements[jobElements.length - 1];
                if (lastJob) {
                    lastJob.scrollIntoView({ block: 'end' });
                    await sleep(1000);
                }

                const newJobElements = getJobListElements();
                if (newJobElements.length <= jobElements.length) {
                    noNewCount++;
                    if (noNewCount >= 2) {
                        log('没有更多岗位了');
                        break;
                    }
                } else {
                    noNewCount = 0;
                    jobElements = newJobElements;
                }
            }

            const jobEl = jobElements[currentIndex];
            currentIndex++;

            const jobInfo = extractJobInfo(jobEl);
            if (!jobInfo || !jobInfo.title) {
                log(`跳过: 无法提取信息 (索引${currentIndex})`, 'warn');
                continue;
            }

            // 生成唯一ID
            const jobId = jobInfo.jobUrl || `${jobInfo.title}_${jobInfo.company}`;

            // 跳过已处理的
            if (processedJobs.has(jobId)) {
                log(`跳过重复: ${jobInfo.title}`);
                continue;
            }
            processedJobs.add(jobId);

            // 检查是否已投递
            if (CONFIG.delivery.skipDelivered && isAlreadyDelivered(jobEl)) {
                log(`跳过已投递: ${jobInfo.title}`, 'warn');
                continue;
            }

            // 检查是否匹配
            if (!isJobMatched(jobInfo)) {
                continue;
            }

            log(`投递: ${jobInfo.title}`);

            // 执行投递
            await deliverJob(jobInfo);

            if (!STATE.isRunning) break;

            // 等待间隔
            const delay = getRandomDelay();
            log(`等待 ${Math.round(delay/1000)}秒...`);
            await sleep(delay);
        }

        STATE.isRunning = false;
        updateStatus();
        log(`完成，本次投递 ${STATE.deliveredCount} 个，共处理 ${processedJobs.size} 个岗位`);
    }

    function stopDelivery() {
        STATE.isRunning = false;
        updateStatus();
        log('已停止');
    }

    // ==================== UI界面 ====================

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'boss-panel';
        panel.innerHTML = `
            <style>
                #boss-panel {
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    background: #fff;
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                    z-index: 99999;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    font-size: 13px;
                    min-width: 200px;
                    user-select: none;
                }
                #boss-panel .hd {
                    background: linear-gradient(135deg, #00b38a, #00a884);
                    color: #fff;
                    padding: 10px 14px;
                    border-radius: 12px 12px 0 0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                }
                #boss-panel .hd .title {
                    font-weight: 600;
                    font-size: 14px;
                }
                #boss-panel .hd .btns {
                    display: flex;
                    gap: 6px;
                }
                #boss-panel .hd .btn {
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: #fff;
                    width: 24px;
                    height: 24px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #boss-panel .hd .btn:hover {
                    background: rgba(255,255,255,0.3);
                }
                #boss-panel .bd {
                    padding: 12px 14px;
                }
                #boss-panel .stats {
                    display: flex;
                    gap: 16px;
                    margin-bottom: 10px;
                }
                #boss-panel .stat {
                    text-align: center;
                }
                #boss-panel .stat-num {
                    font-size: 20px;
                    font-weight: 700;
                    color: #00b38a;
                }
                #boss-panel .stat-label {
                    font-size: 11px;
                    color: #999;
                }
                #boss-panel .action {
                    display: flex;
                    gap: 8px;
                }
                #boss-panel .action button {
                    flex: 1;
                    padding: 8px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                #boss-panel .btn-run {
                    background: #00b38a;
                    color: #fff;
                }
                #boss-panel .btn-run:hover {
                    background: #00a884;
                }
                #boss-panel .btn-run.running {
                    background: #ff4d4f;
                }
                #boss-panel .btn-set {
                    background: #f5f5f5;
                    color: #666;
                }
                #boss-panel .btn-set:hover {
                    background: #eee;
                }
                #boss-panel .log-wrap {
                    margin-top: 10px;
                    border-top: 1px solid #eee;
                    padding-top: 10px;
                }
                #boss-panel .log-hd {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 6px;
                }
                #boss-panel .log-hd span {
                    font-size: 12px;
                    color: #999;
                }
                #boss-panel .log-toggle {
                    font-size: 11px;
                    color: #00b38a;
                    cursor: pointer;
                }
                #boss-panel .log {
                    max-height: 120px;
                    overflow-y: auto;
                    background: #1a1a1a;
                    border-radius: 6px;
                    padding: 8px;
                    font-family: Consolas, monospace;
                    font-size: 11px;
                    line-height: 1.6;
                }
                #boss-panel .log.collapsed {
                    display: none;
                }
                #boss-panel .log-item {
                    color: #52c41a;
                }
                #boss-panel .log-item.warn {
                    color: #faad14;
                }
                #boss-panel .log-item.error {
                    color: #ff4d4f;
                }
                #boss-panel .current-job {
                    margin-top: 8px;
                    padding: 6px 8px;
                    background: #f0f9f6;
                    border-radius: 6px;
                    font-size: 12px;
                    color: #00b38a;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                /* 设置面板 */
                #boss-settings {
                    display: none;
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: #fff;
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
                    z-index: 100000;
                    width: 360px;
                    max-height: 80vh;
                    overflow-y: auto;
                }
                #boss-settings.show {
                    display: block;
                }
                #boss-settings .hd {
                    padding: 14px 16px;
                    border-bottom: 1px solid #eee;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #boss-settings .hd h3 {
                    margin: 0;
                    font-size: 16px;
                }
                #boss-settings .hd .close {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                }
                #boss-settings .bd {
                    padding: 16px;
                }
                #boss-settings .row {
                    margin-bottom: 14px;
                }
                #boss-settings .row label {
                    display: block;
                    font-size: 12px;
                    color: #666;
                    margin-bottom: 6px;
                }
                #boss-settings .row input,
                #boss-settings .row textarea {
                    width: 100%;
                    padding: 8px 10px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    font-size: 13px;
                    box-sizing: border-box;
                }
                #boss-settings .row input:focus,
                #boss-settings .row textarea:focus {
                    outline: none;
                    border-color: #00b38a;
                }
                #boss-settings .row textarea {
                    height: 80px;
                    resize: vertical;
                }
                #boss-settings .tips {
                    font-size: 11px;
                    color: #999;
                    margin-top: 4px;
                }
                #boss-overlay {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.4);
                    z-index: 99999;
                }
                #boss-overlay.show {
                    display: block;
                }
            </style>
            <div class="hd">
                <span class="title">BOSS投递助手</span>
                <div class="btns">
                    <button class="btn" id="boss-min" title="最小化">−</button>
                    <button class="btn" id="boss-close" title="关闭">×</button>
                </div>
            </div>
            <div class="bd" id="boss-content">
                <div class="stats">
                    <div class="stat">
                        <div class="stat-num" id="boss-count">0</div>
                        <div class="stat-label">今日已投</div>
                    </div>
                    <div class="stat">
                        <div class="stat-num" id="boss-limit">50</div>
                        <div class="stat-label">每日上限</div>
                    </div>
                </div>
                <div class="action">
                    <button class="btn-run" id="boss-run">开始投递</button>
                    <button class="btn-set" id="boss-set-btn">设置</button>
                </div>
                <div class="action" style="margin-top:8px">
                    <button class="btn-set" id="boss-debug" style="flex:1">调试: 查找岗位</button>
                </div>
                <div class="current-job" id="boss-current" style="display:none"></div>
                <div class="log-wrap">
                    <div class="log-hd">
                        <span>运行日志</span>
                        <span class="log-toggle" id="boss-log-toggle">收起</span>
                    </div>
                    <div class="log" id="boss-log"></div>
                </div>
            </div>

            <!-- 设置面板 -->
            <div id="boss-overlay"></div>
            <div id="boss-settings">
                <div class="hd">
                    <h3>设置</h3>
                    <button class="close" id="boss-set-close">×</button>
                </div>
                <div class="bd">
                    <div class="row">
                        <label>岗位关键词 (逗号分隔)</label>
                        <input type="text" id="set-keywords" placeholder="前端,JavaScript,Vue">
                        <div class="tips">匹配岗位标题中的关键词</div>
                    </div>
                    <div class="row">
                        <label>排除关键词 (逗号分隔)</label>
                        <input type="text" id="set-exclude" placeholder="外包,驻场">
                    </div>
                    <div class="row">
                        <label>薪资范围 (K)</label>
                        <div style="display:flex;gap:10px">
                            <input type="number" id="set-min-salary" placeholder="最低" style="width:80px">
                            <span style="line-height:36px">-</span>
                            <input type="number" id="set-max-salary" placeholder="最高" style="width:80px">
                        </div>
                    </div>
                    <div class="row">
                        <label>投递间隔 (秒)</label>
                        <input type="number" id="set-interval" placeholder="30">
                    </div>
                    <div class="row">
                        <label>每日上限</label>
                        <input type="number" id="set-max-daily" placeholder="50">
                    </div>
                    <div class="row">
                        <label>AI接口地址 (可选)</label>
                        <input type="text" id="set-ai-url" placeholder="https://api.openai.com/v1/chat/completions">
                    </div>
                    <div class="row">
                        <label>AI Key (可选)</label>
                        <input type="text" id="set-ai-key" placeholder="sk-xxx">
                    </div>
                    <button class="btn-run" id="boss-save" style="width:100%;margin-top:10px">保存设置</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // 初始化显示
        document.getElementById('boss-count').textContent = STATE.todayDelivered;
        document.getElementById('boss-limit').textContent = CONFIG.delivery.maxDaily;

        // 绑定事件
        const runBtn = document.getElementById('boss-run');
        runBtn.addEventListener('click', () => {
            if (STATE.isRunning) {
                stopDelivery();
            } else {
                runAutoDelivery();
            }
        });

        // 最小化
        document.getElementById('boss-min').addEventListener('click', () => {
            const content = document.getElementById('boss-content');
            const btn = document.getElementById('boss-min');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                btn.textContent = '−';
            } else {
                content.style.display = 'none';
                btn.textContent = '+';
            }
        });

        // 关闭
        document.getElementById('boss-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        // 日志折叠
        document.getElementById('boss-log-toggle').addEventListener('click', () => {
            const logEl = document.getElementById('boss-log');
            const toggle = document.getElementById('boss-log-toggle');
            if (logEl.classList.contains('collapsed')) {
                logEl.classList.remove('collapsed');
                toggle.textContent = '收起';
            } else {
                logEl.classList.add('collapsed');
                toggle.textContent = '展开';
            }
        });

        // 设置面板
        const overlay = document.getElementById('boss-overlay');
        const settings = document.getElementById('boss-settings');

        document.getElementById('boss-set-btn').addEventListener('click', () => {
            loadSettingsToForm();
            overlay.classList.add('show');
            settings.classList.add('show');
        });

        document.getElementById('boss-set-close').addEventListener('click', closeSettings);
        overlay.addEventListener('click', closeSettings);

        document.getElementById('boss-save').addEventListener('click', saveSettings);

        // 调试按钮
        document.getElementById('boss-debug').addEventListener('click', debugFindJobs);

        // 拖拽
        makeDraggable(panel);
    }

    function debugFindJobs() {
        log('=== 开始调试 ===');

        const jobs = getJobListElements();
        log(`找到: ${jobs.length} 个岗位`);

        if (jobs.length > 0) {
            const firstJob = jobs[0];
            const info = extractJobInfo(firstJob);
            if (info) {
                log(`岗位: "${info.title}"`);
            }

            // 从当前元素向上查找，找到包含按钮的容器
            let searchArea = firstJob;
            for (let i = 0; i < 5; i++) {
                if (searchArea.parentElement) {
                    searchArea = searchArea.parentElement;
                }
            }

            log(`搜索范围: ${searchArea.tagName}.${searchArea.className.split(' ')[0]}`);

            // 查找所有按钮
            const allBtns = searchArea.querySelectorAll('button, [role="button"], [class*="btn"], a');
            log(`按钮/链接数量: ${allBtns.length}`);

            let found = false;
            allBtns.forEach((btn, i) => {
                const text = btn.textContent.trim();
                if (text.includes('沟通') || text.includes('投递') || i < 5) {
                    log(`  ${i+1}: "${text.substring(0, 15)}" (${btn.tagName})`);
                    found = true;
                }
            });

            if (!found) {
                log('未找到沟通相关按钮');
            }
        }

        log('=== 调试结束 ===');
    }

    function closeSettings() {
        document.getElementById('boss-overlay').classList.remove('show');
        document.getElementById('boss-settings').classList.remove('show');
    }

    function loadSettingsToForm() {
        document.getElementById('set-keywords').value = CONFIG.jobFilter.keywords.join(',');
        document.getElementById('set-exclude').value = CONFIG.jobFilter.excludeKeywords.join(',');
        document.getElementById('set-min-salary').value = CONFIG.jobFilter.minSalary;
        document.getElementById('set-max-salary').value = CONFIG.jobFilter.maxSalary;
        document.getElementById('set-interval').value = CONFIG.delivery.interval / 1000;
        document.getElementById('set-max-daily').value = CONFIG.delivery.maxDaily;
        document.getElementById('set-ai-url').value = CONFIG.ai.apiUrl;
        document.getElementById('set-ai-key').value = CONFIG.ai.apiKey;
    }

    function saveSettings() {
        CONFIG.jobFilter.keywords = document.getElementById('set-keywords').value.split(',').map(s => s.trim()).filter(s => s);
        CONFIG.jobFilter.excludeKeywords = document.getElementById('set-exclude').value.split(',').map(s => s.trim()).filter(s => s);
        CONFIG.jobFilter.minSalary = parseInt(document.getElementById('set-min-salary').value) || 10;
        CONFIG.jobFilter.maxSalary = parseInt(document.getElementById('set-max-salary').value) || 30;
        CONFIG.delivery.interval = (parseInt(document.getElementById('set-interval').value) || 30) * 1000;
        CONFIG.delivery.maxDaily = parseInt(document.getElementById('set-max-daily').value) || 50;
        CONFIG.ai.apiUrl = document.getElementById('set-ai-url').value;
        CONFIG.ai.apiKey = document.getElementById('set-ai-key').value;

        // 保存到存储
        GM_setValue('job_keywords', CONFIG.jobFilter.keywords);
        GM_setValue('exclude_keywords', CONFIG.jobFilter.excludeKeywords);
        GM_setValue('min_salary', CONFIG.jobFilter.minSalary);
        GM_setValue('max_salary', CONFIG.jobFilter.maxSalary);
        GM_setValue('delivery_interval', CONFIG.delivery.interval);
        GM_setValue('max_daily', CONFIG.delivery.maxDaily);
        GM_setValue('ai_api_url', CONFIG.ai.apiUrl);
        GM_setValue('ai_api_key', CONFIG.ai.apiKey);

        // 更新显示
        document.getElementById('boss-limit').textContent = CONFIG.delivery.maxDaily;

        closeSettings();
        log('设置已保存');
    }

    function updateStatus() {
        const runBtn = document.getElementById('boss-run');
        const countEl = document.getElementById('boss-count');
        const currentEl = document.getElementById('boss-current');

        if (runBtn) {
            if (STATE.isRunning) {
                runBtn.textContent = '停止';
                runBtn.classList.add('running');
            } else {
                runBtn.textContent = '开始投递';
                runBtn.classList.remove('running');
            }
        }

        if (countEl) {
            countEl.textContent = STATE.todayDelivered;
        }

        if (currentEl) {
            if (STATE.currentJob) {
                currentEl.textContent = '正在处理: ' + STATE.currentJob;
                currentEl.style.display = 'block';
            } else {
                currentEl.style.display = 'none';
            }
        }
    }

    function updateLogPanel(message, type = 'info') {
        const logEl = document.getElementById('boss-log');
        if (!logEl) return;

        const item = document.createElement('div');
        item.className = 'log-item' + (type !== 'info' ? ' ' + type : '');
        item.textContent = message;
        logEl.appendChild(item);
        logEl.scrollTop = logEl.scrollHeight;

        // 限制日志数量
        while (logEl.children.length > 50) {
            logEl.removeChild(logEl.firstChild);
        }
    }

    function makeDraggable(element) {
        const header = element.querySelector('.hd');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = element.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            element.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            element.style.left = (startLeft + dx) + 'px';
            element.style.top = (startTop + dy) + 'px';
            element.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            element.style.transition = '';
        });
    }

    // ==================== 初始化 ====================

    function init() {
        createPanel();
        log('助手已加载，点击"开始投递"运行');
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

})();
