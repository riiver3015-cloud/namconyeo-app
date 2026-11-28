// 저장된 좌표(계획서 marks)로 체형·골격·얼굴 분석 그림을 그림 — explain.html 과 같은 그림 (report.html 에서 씀)
(() => {
  const loadImg = async (url) => { const b = await (await fetch(url)).blob(); const im = new Image(); im.src = URL.createObjectURL(b); await im.decode(); return im; };
  const ACC = '#FFC928';
  const rr = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
  const line = (g, x1, y1, x2, y2, w, dash) => {
    g.save(); g.lineCap = 'round'; g.setLineDash(dash || []);
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = w * 1.9; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = ACC; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
  };
  const path = (g, pts, w, dash, fill, close = true) => {
    const trace = () => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); };
    g.save(); g.lineJoin = 'round'; g.setLineDash(dash || []);
    if (fill) { trace(); g.fillStyle = fill; g.fill(); }
    trace(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = w * 1.9; g.stroke();
    trace(); g.strokeStyle = ACC; g.lineWidth = w; g.stroke(); g.restore();
  };
  const label = (g, text, x, y, size, align = 'left') => {
    g.save(); g.font = `700 ${size}px "Noto Sans KR", sans-serif`; const tw = g.measureText(text).width, pad = size * 0.45;
    let bx = align === 'right' ? x - tw - pad * 2 : align === 'center' ? x - tw / 2 - pad : x;
    bx = Math.max(4, Math.min(g.canvas.width - tw - pad * 2 - 4, bx));
    g.fillStyle = 'rgba(43,36,32,.85)'; rr(g, bx, y - size * 0.85, tw + pad * 2, size * 1.7, size * 0.45); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, bx + pad, y + size * 0.05); g.restore();
  };
  const crop = (im, sx, sy, sw, sh, outW) => {
    const W = im.naturalWidth, H = im.naturalHeight;
    sw = Math.min(sw, W); sh = Math.min(sh, H); sx = Math.max(0, Math.min(W - sw, sx)); sy = Math.max(0, Math.min(H - sh, sy));
    const k = outW / sw; const c = document.createElement('canvas'); c.width = Math.round(outW); c.height = Math.round(sh * k);
    const g = c.getContext('2d'); g.drawImage(im, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { c, g, k, X: (x) => (x - sx) * k, Y: (y) => (y - sy) * k };
  };
  const joinStrips = (cs) => {
    const H0 = 1100, gap = 14; const sc = cs.map((c) => H0 / c.height); const W0 = cs.reduce((a, c, i) => a + c.width * sc[i], 0) + gap * (cs.length - 1);
    const out = document.createElement('canvas'); out.width = Math.round(W0); out.height = H0; const g = out.getContext('2d'); g.fillStyle = '#fffdf9'; g.fillRect(0, 0, out.width, out.height);
    let x = 0; cs.forEach((c, i) => { const w = c.width * sc[i]; g.drawImage(c, x, 0, w, H0); label(g, ['정면', '측면'][i], x + w / 2, H0 - 40, 30, 'center'); x += w + gap; });
    return out.toDataURL('image/jpeg', 0.88);
  };
  const px = (im, p) => [p.x / 1000 * im.naturalWidth, p.y / 1000 * im.naturalHeight];
  const tick = (g, x, y, h, lw) => line(g, x, y - h, x, y + h, lw);

  const bodyFigM = (im, B) => {
    const H = im.naturalHeight; const top = B.head_top.y / 1000 * H, bot = B.feet_bottom.y / 1000 * H, ch = (bot - top) * 1.1, cw = ch * 0.75;
    const cx = (px(im, B.shoulder_left)[0] + px(im, B.shoulder_right)[0]) / 2;
    const { c, g, X, Y } = crop(im, cx - cw / 2, top - (bot - top) * 0.06, cw, ch, 900);
    const lw = c.width * 0.009, fs = c.width * 0.04;
    const rows = [['어깨', B.shoulder_left, B.shoulder_right], ['허리', B.waist_left, B.waist_right], ['골반', B.hip_left, B.hip_right]].map(([n, l, r]) => [n, px(im, l), px(im, r)]);
    path(g, [rows[0][1], rows[0][2], rows[1][2], rows[2][2], rows[2][1], rows[1][1]].map(([x, y]) => [X(x), Y(y)]), lw * 0.7, [lw * 2, lw * 2], 'rgba(255,201,40,.18)');
    rows.forEach(([n, l, r]) => { const xl = X(l[0]), yl = Y(l[1]), xr = X(r[0]), yr = Y(r[1]); line(g, xl, yl, xr, yr, lw); tick(g, xl, yl, fs * 0.5, lw); tick(g, xr, yr, fs * 0.5, lw); label(g, n, xl - fs * 0.6, yl, fs, 'right'); });
    return c.toDataURL('image/jpeg', 0.88);
  };
  const boneStripM = (im, B, side) => {
    const H = im.naturalHeight; const top = B.head_top.y / 1000 * H, bot = B.feet_bottom.y / 1000 * H, ch = (bot - top) * 1.1, cw = ch * 0.42;
    const mid = side ? (px(im, B.chest_front)[0] + px(im, B.chest_back)[0] + px(im, B.hip_front)[0] + px(im, B.hip_back)[0]) / 4 : (px(im, B.shoulder_left)[0] + px(im, B.shoulder_right)[0]) / 2;
    const { c, g, X, Y } = crop(im, mid - cw / 2, top - (bot - top) * 0.06, cw, ch, 600);
    const lw = c.width * 0.013, fs = c.width * 0.06; const q = (p) => { const [x, y] = px(im, p); return [X(x), Y(y)]; };
    if (!side) {
      const n = q(B.neck_base), sl = q(B.shoulder_left), sr = q(B.shoulder_right), wl = q(B.waist_left), wr = q(B.waist_right);
      line(g, n[0], n[1], sl[0], sl[1], lw); line(g, n[0], n[1], sr[0], sr[1], lw);
      line(g, sl[0], sl[1], wl[0], wl[1], lw * 0.7, [lw * 2, lw * 2]); line(g, sr[0], sr[1], wr[0], wr[1], lw * 0.7, [lw * 2, lw * 2]);
      label(g, '어깨선', n[0], n[1] - fs * 1.3, fs, 'center');
    } else {
      [[B.chest_front, B.chest_back, '상체 두께'], [B.hip_front, B.hip_back, '하체 두께']].forEach(([a, b, name]) => {
        const p1 = q(a), p2 = q(b); line(g, p1[0], p1[1], p2[0], p2[1], lw); tick(g, p1[0], p1[1], fs * 0.4, lw); tick(g, p2[0], p2[1], fs * 0.4, lw);
        label(g, name, (p1[0] + p2[0]) / 2, Math.min(p1[1], p2[1]) - fs * 1.1, fs, 'center');
      });
    }
    return c;
  };
  const faceFigsM = (im, F, shape, ratio) => {
    const ol = F.outline.map((p) => px(im, p)); const hl = px(im, F.hairline), ch = px(im, F.chin);
    const xs = ol.map((p) => p[0]), ys = ol.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, hl[1]), y1 = Math.max(...ys, ch[1]), fw = x1 - x0;
    const size = Math.max(fw * 2, (y1 - y0) * 1.5), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const mk = () => crop(im, cx - size / 2, cy - size / 2, size, size, 800);
    const A = mk(); { const { c, g, X, Y } = A; const lw = c.width * 0.008, fs = c.width * 0.045; const pts = ol.map(([x, y]) => [X(x), Y(y)]), n = pts.length;
      // 점들을 부드러운 곡선으로 이음
      const trace = () => { const mid = (i) => [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2]; const m0 = mid(n - 1); g.beginPath(); g.moveTo(m0[0], m0[1]); for (let i = 0; i < n; i++) { const m = mid(i); g.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); } g.closePath(); };
      g.save(); g.lineJoin = 'round'; trace(); g.fillStyle = 'rgba(255,201,40,.12)'; g.fill(); trace(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = lw * 1.9; g.stroke(); trace(); g.strokeStyle = ACC; g.lineWidth = lw; g.stroke(); g.restore();
      if (shape) label(g, shape, c.width / 2, c.height - fs * 1.3, fs * 1.1, 'center');
    }
    const B = mk(); { const { c, g, X, Y } = B; const lw = c.width * 0.007, fs = c.width * 0.04;
      const xa = X(x0 - fw * 0.1), xb = X(x1 + fw * 0.1), bx = X(x1 + fw * 0.22);
      const yy = [F.hairline, F.brow_line, F.nose_base, F.chin].map((p) => Y(px(im, p)[1]));
      yy.forEach((y) => line(g, xa, y, xb, y, lw));
      ['상안부', '중안부', '하안부'].forEach((nm, i) => {
        line(g, bx, yy[i] + lw * 2, bx, yy[i + 1] - lw * 2, lw * 0.8);
        line(g, bx - fs * 0.25, yy[i] + lw * 2, bx + fs * 0.25, yy[i] + lw * 2, lw * 0.8); line(g, bx - fs * 0.25, yy[i + 1] - lw * 2, bx + fs * 0.25, yy[i + 1] - lw * 2, lw * 0.8);
        label(g, nm, bx + fs * 0.6, (yy[i] + yy[i + 1]) / 2, fs, 'left');
      });
      const d = [yy[1] - yy[0], yy[2] - yy[1], yy[3] - yy[2]];
      label(g, ratio || `1 : ${(d[1] / d[0]).toFixed(1)} : ${(d[2] / d[0]).toFixed(1)}`, c.width / 2, c.height - fs * 1.3, fs * 1.1, 'center');
    }
    return [A.c.toDataURL('image/jpeg', 0.88), B.c.toDataURL('image/jpeg', 0.88)];
  };
  window.NK_MARKDRAW = { loadImg, bodyFigM, boneStripM, joinStrips, faceFigsM };
})();
