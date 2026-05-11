// ==UserScript==
// @name         BOSS终极自动投递系统（修复版）
// @namespace    http://tampermonkey.net/
// @version      6.3.0
// @match        https://www.zhipin.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        keywords: GM_getValue('keywords', '前端,Vue,React'),
        exclude: GM_getValue('exclude', '外包,驻场'),
        autoMsg: GM_getValue('autoMsg', '您好，我对这个岗位很感兴趣，期待沟通！'),
        max: 300
    };

    const STATE = {
        running: false,
        count: 0,
        matched: 0,
        excluded: 0
    };

    const done = new Set();
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function log(msg) {
        console.log('[终极版]', msg);
    }

    function delay() {
        if (STATE.count < 50) return 3000 + Math.random()*1000;
        if (STATE.count < 150) return 4000 + Math.random()*2000;
        return 5000 + Math.random()*3000;
    }

    function getJobs() {
        return [...document.querySelectorAll('a[href*="/job_detail/"]')]
            .map(a => a.closest('li') || a.closest('div'))
            .filter(Boolean);
    }

    function getInfo(el) {
        const a = el.querySelector('a[href*="/job_detail/"]');
        if (!a) return null;
        return { title: a.textContent.trim(), url: a.href };
    }

    function match(title) {
        const k = CONFIG.keywords.split(',');
        const e = CONFIG.exclude.split(',');
        if (e.some(x => title.includes(x))) return false;
        return k.some(x => title.toLowerCase().includes(x.toLowerCase()));
    }

    function isSent(el) {
        return el.textContent.includes('已沟通') || el.textContent.includes('已投递');
    }

    async function handlePopup() {
        const txt = ['留在此页','取消'];
        for (let i = 0; i < 10; i++){
            for (const b of document.querySelectorAll('button,span,a')){
                if (txt.includes(b.textContent.trim())){
                    log('点击弹窗按钮: ' + b.textContent.trim());
                    b.click();
                    await sleep(500);
                    return true;
                }
            }
            await sleep(300);
        }
        return false;
    }

    async function sendMsg() {
        const input = document.querySelector('textarea');
        if (input) {
            input.value = CONFIG.autoMsg;
            input.dispatchEvent(new Event('input'));
            log('已发送打招呼');
        }
    }

    // 检查是否有弹窗
    function hasPopup() {
        const popupTexts = ['留在此页', '取消', '继续沟通'];
        for (const b of document.querySelectorAll('button,span,a')) {
            if (popupTexts.includes(b.textContent.trim())) {
                return true;
            }
        }
        return false;
    }

    // 关闭职位详情弹窗
    async function closeJobDetail() {
        // 尝试点击关闭按钮
        const closeBtns = document.querySelectorAll('[class*="close"], [class*="Close"], .ka-icon-close, .dialog-close');
        for (const btn of closeBtns) {
            if (btn.offsetParent) {
                btn.click();
                await sleep(300);
            }
        }
        // 按ESC键关闭
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27}));
        await sleep(300);
    }

    async function deliver(el) {
        el.scrollIntoView({block:'center'});
        await sleep(300);

        // 先处理可能存在的弹窗
        await handlePopup();

        // 点击职位进入详情
        el.querySelector('a')?.click();
        await sleep(1200);

        // 再次检查弹窗
        await handlePopup();
        await sleep(500);

        // 查找"立即沟通"按钮
        let foundBtn = null;
        for (const b of document.querySelectorAll('button,a,.btn')){
            if (b.textContent.trim() === '立即沟通' || b.textContent.includes('立即沟通')){
                log('找到立即沟通按钮');
                foundBtn = b;
                break;
            }
        }

        if (!foundBtn) {
            log('未找到立即沟通按钮，跳过此职位');
            await closeJobDetail();
            return false;
        }

        // 点击"立即沟通"
        foundBtn.click();
        log('点击立即沟通');
        await sleep(1000);

        // 等待并处理弹窗 - 点击"留在此页"
        log('等待弹窗出现...');
        let popupClicked = false;
        for (let i = 0; i < 15; i++) {
            // 查找"留在此页"按钮
            for (const b of document.querySelectorAll('button,span,a,.btn')) {
                const text = b.textContent.trim();
                if (text === '留在此页' || text === '取消') {
                    log('发现弹窗按钮: ' + text);
                    b.click();
                    log('已点击: ' + text);
                    popupClicked = true;
                    await sleep(800);
                    break;
                }
            }
            if (popupClicked) break;
            await sleep(400);
        }

        if (!popupClicked) {
            log('未检测到弹窗，可能已直接进入沟通');
        }

        // 发送打招呼消息
        await sendMsg();
        await sleep(500);

        // 关闭详情页
        await closeJobDetail();

        return true;
    }

    async function startRun() {
        if (STATE.running) return;
        STATE.running = true;

        while (STATE.running && STATE.count < CONFIG.max){

            const list = getJobs();
            let found = false;

            for (const el of list){
                if (!STATE.running) break;
                if (!el.offsetParent) continue;

                const info = getInfo(el);
                if (!info) continue;

                if (done.has(info.url)) continue;
                done.add(info.url);

                if (isSent(el)) continue;
                if (!match(info.title)) {
                    STATE.excluded++;
                    updateStats();
                    continue;
                }

                STATE.matched++;
                updateStats();
                found = true;

                log(`投递(${STATE.count}) ${info.title}`);

                const ok = await deliver(el);
                if (ok) {
                    STATE.count++;
                    updateStats();
                }

                await sleep(delay());

                if (STATE.count % 50 === 0){
                    log('休息30秒');
                    await sleep(30000);
                }
            }

            if (!found){
                list[list.length-1]?.scrollIntoView({block:'end'});
                await sleep(1500);

                const next = [...document.querySelectorAll('a,button')]
                    .find(b => b.textContent.includes('下一页'));
                next?.click();
                await sleep(2000);
            }
        }

        STATE.running = false;
        log('完成');
    }

    function updateStats() {
        const el = document.getElementById('statsPanel');
        if (el) {
            el.innerHTML = `
                <div style="display:flex;gap:15px;font-size:13px;color:#666;">
                    <div>投递: <b style="color:#00beaa;">${STATE.count}</b></div>
                    <div>匹配: <b style="color:#1890ff;">${STATE.matched}</b></div>
                    <div>排除: <b style="color:#ff4d4f;">${STATE.excluded}</b></div>
                </div>
            `;
        }
    }

    function createUI(){
        const div = document.createElement('div');
        div.innerHTML = `
        <div id="controlPanel" style="position:fixed;right:20px;top:100px;background:#fff;padding:15px;z-index:99999;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.15);min-width:200px;user-select:none;">
            <div id="panelHeader" style="cursor:move;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid #eee;font-weight:bold;color:#333;display:flex;justify-content:space-between;align-items:center;">
                <span>BOSS自动投递</span>
                <span style="font-weight:normal;font-size:12px;color:#999;">拖动移动</span>
            </div>
            <div id="statsPanel" style="padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid #eee;">
                <div style="display:flex;gap:15px;font-size:13px;color:#666;">
                    <div>投递: <b style="color:#00beaa;">0</b></div>
                    <div>匹配: <b style="color:#1890ff;">0</b></div>
                    <div>排除: <b style="color:#ff4d4f;">0</b></div>
                </div>
            </div>
            <div style="display:flex;gap:10px;">
                <button id="runBtn" style="flex:1;padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;background:#00beaa;color:#fff;">开始</button>
                <button id="setBtn" style="flex:1;padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;background:#f0f0f0;color:#333;">设置</button>
            </div>
        </div>
        <div id="box" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:#fff;padding:20px;z-index:100000;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.2);min-width:300px;">
            <div style="font-weight:bold;margin-bottom:15px;color:#333;">设置</div>
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:5px;">关键词:</label>
                <input id="k" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:5px;">排除词:</label>
                <input id="e" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:15px;">
                <label style="display:block;font-size:13px;color:#666;margin-bottom:5px;">打招呼:</label>
                <input id="m" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
            </div>
            <div style="display:flex;gap:10px;">
                <button id="saveBtn" style="flex:1;padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;background:#00beaa;color:#fff;">保存</button>
                <button id="cancelBtn" style="flex:1;padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;background:#f0f0f0;color:#333;">取消</button>
            </div>
        </div>
        `;
        document.body.appendChild(div);

        const panel = document.getElementById('controlPanel');
        const header = document.getElementById('panelHeader');
        const runBtn = document.getElementById('runBtn');
        const setBtn = document.getElementById('setBtn');
        const saveBtn = document.getElementById('saveBtn');
        const cancelBtn = document.getElementById('cancelBtn');
        const box = document.getElementById('box');

        // 拖动功能
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.onmousedown = (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        };

        document.onmousemove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = (startLeft + dx) + 'px';
            panel.style.top = (startTop + dy) + 'px';
            panel.style.right = 'auto';
        };

        document.onmouseup = () => {
            isDragging = false;
        };

        runBtn.onclick = () => {
            if (STATE.running){
                STATE.running = false;
                runBtn.innerText = '开始';
                runBtn.style.background = '#00beaa';
            } else {
                startRun();
                runBtn.innerText = '停止';
                runBtn.style.background = '#ff4d4f';
            }
        };

        setBtn.onclick = () => {
            box.style.display = 'block';
            document.getElementById('k').value = CONFIG.keywords;
            document.getElementById('e').value = CONFIG.exclude;
            document.getElementById('m').value = CONFIG.autoMsg;
        };

        saveBtn.onclick = () => {
            CONFIG.keywords = document.getElementById('k').value;
            CONFIG.exclude = document.getElementById('e').value;
            CONFIG.autoMsg = document.getElementById('m').value;

            GM_setValue('keywords', CONFIG.keywords);
            GM_setValue('exclude', CONFIG.exclude);
            GM_setValue('autoMsg', CONFIG.autoMsg);

            box.style.display = 'none';
            alert('保存成功');
        };

        cancelBtn.onclick = () => {
            box.style.display = 'none';
        };
    }

    window.addEventListener('load', createUI);

})();
