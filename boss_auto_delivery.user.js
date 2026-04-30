// ==UserScript==
// @name         BOSS终极自动投递系统（修复版）
// @namespace    http://tampermonkey.net/
// @version      6.1.0
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
        count: 0
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
        for (let i=0;i<4;i++){
            for (const b of document.querySelectorAll('button,span,a')){
                if (txt.includes(b.textContent.trim())){
                    b.click();
                    return;
                }
            }
            await sleep(300);
        }
    }

    async function sendMsg() {
        const input = document.querySelector('textarea');
        if (input) {
            input.value = CONFIG.autoMsg;
            input.dispatchEvent(new Event('input'));
        }
    }

    async function deliver(el) {
        el.scrollIntoView({block:'center'});
        await sleep(300);

        el.querySelector('a')?.click();
        await sleep(800);

        for (const b of document.querySelectorAll('button,a')){
            if (b.textContent.trim()==='立即沟通'){
                b.click();
                await sleep(500);
                await sendMsg();
                await handlePopup();
                return true;
            }
        }
        return false;
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
                if (!match(info.title)) continue;

                found = true;

                log(`投递(${STATE.count}) ${info.title}`);

                const ok = await deliver(el);
                if (ok) STATE.count++;

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

    function createUI(){
        const div = document.createElement('div');
        div.innerHTML = `
        <div style="position:fixed;right:20px;top:100px;background:#fff;padding:10px;z-index:99999">
            <button id="runBtn">开始</button>
            <button id="setBtn">设置</button>
        </div>
        <div id="box" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:#fff;padding:20px;z-index:100000">
            关键词:<input id="k"><br>
            排除:<input id="e"><br>
            打招呼:<input id="m"><br>
            <button id="saveBtn">保存</button>
        </div>
        `;
        document.body.appendChild(div);

        const runBtn = document.getElementById('runBtn');
        const setBtn = document.getElementById('setBtn');
        const saveBtn = document.getElementById('saveBtn');
        const box = document.getElementById('box');

        runBtn.onclick = () => {
            if (STATE.running){
                STATE.running = false;
                runBtn.innerText = '开始';
            } else {
                startRun();
                runBtn.innerText = '停止';
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
    }

    window.addEventListener('load', createUI);

})();
