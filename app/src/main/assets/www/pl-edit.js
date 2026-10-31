/* ════════════════════════════════════════════════════════════════════
   PLAYLIST TRACK EDIT  (롱프레스 편집 · 컨텍스트 메뉴 · 드래그 순서 변경)
   - 플레이리스트 상세(#pl-track-list)의 곡 행을 길게 누르면 edit 상태로 진입한다.
       · 행이 부드럽게 커지며(spring) 하이라이트 되고, 행 옆에 Liquid Glass 컨텍스트 메뉴가 나타난다.
       · 메뉴: 곡 삭제 / 곡 즐겨찾기   (Liquid Glass 표면은 네이티브 Compose 가 그린다 → GlassTrackMenu.kt)
       · edit 상태의 행을 위/아래로 드래그하면 순서가 바뀌고, 다른 행들은 "구멍에서 바깥쪽으로" 순차적으로
         밀려나며(겹침 없이) 자리를 비켜 준다. 놓으면 제자리에 안착한 뒤 순서가 저장된다.
   - app.js 는 수정하지 않는다. 기존 함수(PL / plById / plSave / plRemoveTrack / toggleFavTrack / playTrack)를 그대로 호출한다.
       DOM → Native : window.__plEdit.glass()   (glass-bridge.js 의 collect() 가 읽어 간다)
       Native → DOM : window.__plEdit.action('fav' | 'del')   (glass-bridge.js 의 __glassCmd 'tedit')
════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    const listEl = document.getElementById('pl-track-list');
    if (!listEl) return;

    const root = document.documentElement;
    const NATIVE = !!window.GlassBridge;

    const LONG_MS = 400;          // 롱프레스 시간
    const SLOP = 6;               // 롱프레스 중 허용 이동(px) — swipe-nav 의 LOCK_SLOP 과 동일
    const DRAG_START = 4;         // edit 상태에서 드래그로 인정하는 최소 이동(px)
    const STAGGER = 22;           // 주변 행 순차 이동 간격(ms)
    const SETTLE_MS = 360;        // 놓은 뒤 안착 애니메이션 시간
    const EDGE_TOP = 110, EDGE_BOTTOM = 170;   // 자동 스크롤 영역(px) — 상단 / 하단(내비+미니플레이어)
    const MENU_W = 212, MENU_H = 114;          // GlassState.kt 의 TrackEditState 와 동일해야 한다 (폴백 메뉴 위치용)

    let E = null;            // 현재 edit 세션
    let C = null;            // 닫히는 중인 세션의 스냅샷(네이티브 메뉴 페이드 아웃용)
    let press = null;        // 롱프레스 대기
    let swallowUntil = 0;    // 롱프레스/드래그 직후 합성되는 click 무시 시간
    let closeTimer = 0;

    const rows = () => Array.prototype.filter.call(listEl.children, n => n.classList && n.classList.contains('pl-track'));
    const curPl = () => (typeof PL !== 'undefined' && PL.curId) ? plById(PL.curId) : null;
    const kick = ms => { try { if (window.__glassKick) window.__glassKick(ms || 600); } catch (e) { } };
    const buzz = () => { try { if (navigator.vibrate) navigator.vibrate(14); } catch (e) { } };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    /* ───────────────────── 재생 상태 동기화 (하이라이트 / 이퀄라이저) ───────────────────── */
    function syncPlaying() {
        const pl = curPl();
        if (!pl) return;
        const id = (typeof S !== 'undefined' && S.track) ? S.track.id : null;
        rows().forEach((r, i) => r.classList.toggle('playing', !!id && !!pl.tracks[i] && pl.tracks[i].id === id));
    }
    function syncPaused() {
        root.classList.toggle('eq-paused', !(typeof S !== 'undefined' && S.playing));
    }
    function wrap(name, after) {
        const f = window[name];
        if (typeof f !== 'function' || f.__plWrapped) return;
        const w = function () {
            const r = f.apply(this, arguments);
            try { after(); } catch (e) { }
            return r;
        };
        w.__plWrapped = true;
        window[name] = w;
    }
    wrap('applyTrackUi', syncPlaying);   // 곡이 바뀌면 플레이리스트 행의 하이라이트도 즉시 갱신
    wrap('updPlay', syncPaused);         // 일시정지 중에는 이퀄라이저 정지
    syncPaused();

    /* ───────────────────── 롱프레스 → edit 진입 ───────────────────── */
    function cancelPress() { if (press) { clearTimeout(press.timer); press = null; } }

    listEl.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) { cancelPress(); return; }
        const row = e.target.closest ? e.target.closest('.pl-track') : null;
        if (!row || !listEl.contains(row)) return;
        const t = e.touches[0];
        if (E) {
            if (E.busy) return;
            if (row === E.row) { E.finger = true; E.gesture = false; E.x0 = t.clientX; E.y0 = t.clientY; E.cy = t.clientY; }
            return;
        }
        if (e.target.closest('.pl-track-del')) return;
        press = {
            row: row, x: t.clientX, y: t.clientY,
            timer: setTimeout(() => {
                const p = press; press = null;
                if (p && p.row.isConnected) enterEdit(p.row, p.x, p.y);
            }, LONG_MS)
        };
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        if (press) {
            const t = e.touches[0];
            if (Math.abs(t.clientX - press.x) > SLOP || Math.abs(t.clientY - press.y) > SLOP) cancelPress();
            return;
        }
        if (!E) return;
        if (e.cancelable) e.preventDefault();                 // edit 중에는 문서 스크롤 잠금
        if (!E.finger || E.busy || e.touches.length !== 1) return;
        E.cy = e.touches[0].clientY;
        if (!E.dragging) {
            if (Math.abs(E.cy - E.y0) < DRAG_START) return;
            beginDrag(E);
        }
        updateDrag(E);
    }, { passive: false, capture: true });

    function onEnd(e) {
        cancelPress();
        if (!E || !E.finger) return;
        E.finger = false;
        if (E.gesture) {                                      // 롱프레스를 뗀 직후 / 드래그 직후의 click 은 무시
            swallowUntil = performance.now() + 450;
            if (e.cancelable) e.preventDefault();
        }
        if (E.dragging) endDrag(E);
    }
    document.addEventListener('touchend', onEnd, { passive: false, capture: true });
    document.addEventListener('touchcancel', onEnd, { passive: false, capture: true });

    document.addEventListener('contextmenu', e => {
        if (e.target.closest && e.target.closest('#pl-track-list')) e.preventDefault();
    }, true);

    function enterEdit(row, x, y) {
        const pl = curPl();
        if (!pl) return;
        const idx = rows().indexOf(row);
        if (idx < 0 || !pl.tracks[idx]) return;
        clearTimeout(closeTimer); C = null;
        E = {
            plId: pl.id, row: row, idx: idx, track: pl.tracks[idx],
            finger: true, gesture: true, dragging: false, busy: false,
            x0: x, y0: y, cy: y, to: idx
        };
        root.classList.add('pl-editing');
        listEl.classList.add('is-editing');
        row.classList.add('editing');
        buzz();
        showFallbackMenu();
        kick(800);
    }

    /* ───────────────────── 드래그로 순서 변경 ───────────────────── */
    function beginDrag(s) {
        const rs = rows();
        const from = rs.indexOf(s.row);
        if (from < 0) { exitEdit(true); return; }
        s.rows = rs; s.from = from; s.to = from;
        s.base = rs.map(r => r.offsetTop);
        s.h = rs.map(r => r.offsetHeight);
        s.gap = rs.length > 1 ? Math.max(0, s.base[1] - (s.base[0] + s.h[0])) : 0;
        s.cur = rs.map(() => 0);
        s.tops = null;
        s.pageY0 = s.y0 + window.scrollY;
        s.dragging = true; s.gesture = true;
        s.row.style.transitionDelay = '0ms';
        s.row.classList.add('dragging');
        hideFallbackMenu();
        startAuto(s);
        kick(500);
    }

    /** 놓았을 때의 최종 배치: 각 원본 인덱스 → 새 top 좌표 (행 높이 + 간격 누적 — 겹칠 수 없는 구조) */
    function layoutFor(s, to) {
        const order = s.rows.map((_, i) => i);
        order.splice(s.from, 1);
        order.splice(to, 0, s.from);
        const tops = new Array(order.length);
        let y = s.base[0];
        order.forEach(i => { tops[i] = y; y += s.h[i] + s.gap; });
        return tops;
    }

    function updateDrag(s) {
        const n = s.rows.length, from = s.from, last = n - 1;
        const minTop = s.base[0];
        const maxTop = s.base[last] + s.h[last] - s.h[from];
        const rawTop = s.base[from] + ((s.cy + window.scrollY) - s.pageY0);
        const top = clamp(rawTop, minTop, maxTop);
        s.row.style.setProperty('--dy', (top - s.base[from]).toFixed(1) + 'px');

        /* 위치 판정은 "원래 배치" 기준 — 이동 중인 행의 현재 위치에 영향받지 않아 떨림이 없다.
           이웃 행과 35% 겹치면 자리를 바꾼다. */
        const bottom = top + s.h[from];
        let to = from;
        for (let j = from + 1; j < n; j++) { if (bottom >= s.base[j] + s.h[j] * 0.35) to = j; else break; }
        for (let j = from - 1; j >= 0; j--) { if (top <= s.base[j] + s.h[j] * 0.65) to = j; else break; }
        if (to !== s.to) { s.to = to; applyShifts(s, to); }
    }

    /** 주변 행 이동. "구멍(빈 자리)에 가장 가까운 행부터" 순차적으로 출발시켜 서로 겹치지 않고 컨베이어처럼 이어진다.
     *  - 위로 올라가는 행: 위쪽(작은 인덱스)부터 / 아래로 내려가는 행: 아래쪽(큰 인덱스)부터 */
    function applyShifts(s, to) {
        const tops = layoutFor(s, to);
        const ups = [], downs = [];
        s.rows.forEach((r, k) => {
            if (k === s.from) return;
            const d = tops[k] - s.base[k];
            const prev = s.cur[k];
            if (Math.abs(d - prev) < 0.5) return;
            (d < prev ? ups : downs).push({ k: k, d: d });
        });
        ups.sort((a, b) => a.k - b.k);
        downs.sort((a, b) => b.k - a.k);
        const go = list => list.forEach((it, rank) => {
            const r = s.rows[it.k];
            r.style.transitionDelay = Math.min(rank, 5) * STAGGER + 'ms';
            r.style.setProperty('--dy', it.d + 'px');
            s.cur[it.k] = it.d;
        });
        go(ups); go(downs);
        s.tops = tops;
    }

    function endDrag(s) {
        if (!s.dragging || s.busy) return;
        stopAuto(s);
        s.busy = true;
        const tops = s.tops || s.base;
        s.row.style.transitionDelay = '0ms';
        s.row.classList.remove('dragging');
        s.row.classList.add('settling');
        s.row.style.setProperty('--dy', (tops[s.from] - s.base[s.from]) + 'px');   // 최종 슬롯으로 안착
        s.settleT = setTimeout(() => commit(s), SETTLE_MS);
        kick(SETTLE_MS + 200);
    }

    /** 안착 완료: 데이터 순서 저장 + DOM 노드를 실제 순서로 이동(트랜지션 없이 → 시각적으로 동일, 이미지 재로딩 없음) */
    function commit(s) {
        if (!s.dragging) return;
        clearTimeout(s.settleT);
        const from = s.from, to = s.to, rs = s.rows, pl = plById(s.plId);
        listEl.classList.add('no-anim');
        if (pl && to !== from && pl.tracks[from] && s.row.isConnected) {
            const moved = pl.tracks.splice(from, 1)[0];
            pl.tracks.splice(to, 0, moved);
            try { plSave(); } catch (e) { }
            listEl.insertBefore(s.row, to > from ? rs[to].nextSibling : rs[to]);
        }
        rs.forEach(r => { r.style.removeProperty('--dy'); r.style.transitionDelay = ''; });
        s.row.classList.remove('settling');
        rows().forEach((r, i) => { const n = r.querySelector('.pl-track-num'); if (n) n.textContent = String(i + 1); });
        void listEl.offsetHeight;                  // 스타일 확정 후 트랜지션 복구
        listEl.classList.remove('no-anim');
        s.dragging = false; s.busy = false; s.idx = to; s.from = to;
        syncPlaying();
        if (E === s) { showFallbackMenu(); kick(700); }
    }

    /* 화면 가장자리에서 자동 스크롤 */
    function startAuto(s) {
        stopAuto(s);
        const tick = () => {
            if (E !== s || !s.dragging || s.busy) return;
            const vh = window.innerHeight;
            let v = 0;
            if (s.cy < EDGE_TOP) v = -Math.min(16, (EDGE_TOP - s.cy) / EDGE_TOP * 18 + 2);
            else if (s.cy > vh - EDGE_BOTTOM) v = Math.min(16, (s.cy - (vh - EDGE_BOTTOM)) / EDGE_BOTTOM * 18 + 2);
            if (v) {
                const before = window.scrollY;
                window.scrollBy(0, v);
                if (window.scrollY !== before) updateDrag(s);
            }
            s.raf = requestAnimationFrame(tick);
        };
        s.raf = requestAnimationFrame(tick);
    }
    function stopAuto(s) { if (s && s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; } }

    /* ───────────────────── 종료 ───────────────────── */
    function exitEdit(instant) {
        if (!E) return;
        const s = E;
        if (s.dragging && s.busy) commit(s);                  // 안착 중에 종료돼도 순서는 잃지 않는다
        E = null;
        stopAuto(s);
        clearTimeout(s.settleT);
        hideFallbackMenu();
        if (NATIVE && !instant && s.row.isConnected) {        // 네이티브 메뉴가 사라지는 동안 위치를 유지하기 위한 스냅샷
            C = payload(s, true);
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => { C = null; kick(300); }, 200);
        } else { C = null; }
        listEl.classList.remove('is-editing');
        root.classList.remove('pl-editing');
        s.row.classList.remove('editing', 'dragging', 'settling');
        (s.rows || rows()).forEach(r => { r.style.removeProperty('--dy'); r.style.transitionDelay = ''; });
        kick(700);
    }

    /* ───────────────────── 메뉴 동작 ───────────────────── */
    function removeAnimated(row, plId, trackId) {
        if (row && row.isConnected) {
            row.style.height = row.offsetHeight + 'px';
            void row.offsetHeight;
            row.classList.add('removing');
            row.style.height = '0px';
        }
        setTimeout(() => { try { plRemoveTrack(plId, trackId); } catch (e) { } }, 300);
    }

    function action(a) {
        if (!E || E.busy) return;
        const s = E;
        if (a === 'fav') {
            const t = s.track;
            exitEdit();
            try { toggleFavTrack(t); } catch (e) { }
        } else if (a === 'del') {
            const row = s.row, plId = s.plId, id = s.track.id;
            exitEdit();
            removeAnimated(row, plId, id);
        }
    }

    /* ───────────────────── Native Glass 로 보내는 상태 ───────────────────── */
    function payload(s, closing) {
        const r = s.row.getBoundingClientRect();
        const fav = (typeof isFav === 'function') && isFav(s.track.id);
        return {
            r: { x: r.left, y: r.top, w: r.width, h: r.height }, vh: window.innerHeight,
            dr: s.dragging ? 1 : 0, cl: closing ? 1 : 0,
            fav: fav ? 1 : 0, fl: fav ? '즐겨찾기 해제' : '즐겨찾기', dl: '곡 삭제'
        };
    }

    window.__plEdit = {
        glass: function () {
            if (E) return (E.row.isConnected && E.row.offsetParent) ? payload(E, false) : null;
            return C;
        },
        action: action,
        exit: exitEdit
    };

    /* ───────────────────── 브라우저 단독 실행용 폴백 메뉴 (앱에서는 네이티브 글래스가 대신 그린다) ───────────────────── */
    let fb = null;
    function ensureFb() {
        if (fb) return fb;
        fb = document.createElement('div');
        fb.id = 'pl-edit-menu';
        fb.innerHTML =
            '<button type="button" data-a="fav"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16.5S3 12 3 7.5a3.5 3.5 0 0 1 7-1A3.5 3.5 0 0 1 17 7.5C17 12 10 16.5 10 16.5z"/></svg><span></span></button>' +
            '<button type="button" data-a="del" class="danger"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V4a1.2 1.2 0 0 1 1.2-1.2h1.6A1.2 1.2 0 0 1 12 4v1.5M5.2 5.5l.8 10.1a1.5 1.5 0 0 0 1.5 1.4h5a1.5 1.5 0 0 0 1.5-1.4l.8-10.1M8.3 9v5M11.7 9v5"/></svg><span>곡 삭제</span></button>';
        fb.addEventListener('click', e => {
            const b = e.target.closest('button[data-a]');
            if (b) { e.stopPropagation(); action(b.dataset.a); }
        });
        document.body.appendChild(fb);
        return fb;
    }
    function showFallbackMenu() {
        if (NATIVE || !E) return;
        const m = ensureFb();
        const p = payload(E, false);
        m.querySelector('[data-a="fav"] span').textContent = p.fl;
        m.querySelector('[data-a="fav"]').classList.toggle('on', !!p.fav);
        const gap = 10;
        const x = Math.max(10, p.r.x + p.r.w - MENU_W - 14);
        const below = p.r.y + p.r.h + gap;
        const y = (below + MENU_H <= p.vh - 150) ? below : Math.max(10, p.r.y - gap - MENU_H);
        m.style.left = x + 'px'; m.style.top = y + 'px';
        m.classList.add('on');
    }
    function hideFallbackMenu() { if (fb) fb.classList.remove('on'); }

    /* ───────────────────── click 가로채기 ───────────────────── */
    document.addEventListener('click', e => {
        if (performance.now() < swallowUntil) { e.preventDefault(); e.stopImmediatePropagation(); return; }

        if (E) {
            if (E.busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
            if (fb && fb.contains(e.target)) return;                 // 폴백 메뉴 자체 핸들러
            const inList = listEl.contains(e.target);
            exitEdit();                                              // 바깥을 누르면 edit 종료
            if (inList) { e.preventDefault(); e.stopImmediatePropagation(); }   // 다른 곡이 재생되지는 않는다
            return;
        }

        /* 일반 모드: 행 탭 = 재생. app.js 가 행마다 붙여 둔 핸들러는 렌더 시점의 인덱스를 캡처하고 있어
           순서 변경 후에는 낡은 인덱스가 되므로, 여기서 "현재 DOM 순서"로 동일한 동작을 수행한다. */
        const row = e.target.closest ? e.target.closest('.pl-track') : null;
        if (!row || !listEl.contains(row) || e.target.closest('.pl-track-del')) return;
        const pl = curPl();
        const i = rows().indexOf(row);
        if (!pl || i < 0 || !pl.tracks[i]) return;
        e.stopImmediatePropagation(); e.preventDefault();
        try { plCtxClose(); } catch (err) { }
        S.q = [...pl.tracks]; S.idx = i; playTrack(pl.tracks[i], i);
    }, true);

    /* 안드로이드 뒤로가기: edit 상태면 먼저 종료 */
    const prevBack = window.__onAndroidBack;
    window.__onAndroidBack = function () {
        if (E) { exitEdit(); return; }
        if (typeof prevBack === 'function') return prevBack.apply(this, arguments);
    };

    /* 목록이 다시 그려져 편집 중인 행이 사라지면 즉시 종료 */
    new MutationObserver(() => { if (E && !E.row.isConnected) exitEdit(true); }).observe(listEl, { childList: true });
})();
