(function(){
  const DEFAULTS = {
    sessionMinutes: 45,
    breakMinutes: 10,
    postureSensitivity: 1.0,
    shoulderWidthRef: 0,
    ttsEnabled: true,
    ttsRate: 1.02,
    ttsPitch: 1.25,
    ttsVolume: 1.0,
    preferFemale: true,
    cameraFacingMode: 'user',
    warningCooldownSec: 6,
    warningLines: [
      '宝贝，坐直一点哦。背要挺起来。',
      '小朋友，离书本太近啦，眼睛要和书保持一拳距离。',
      '肩膀放松，别趴着写。把腰挺直。',
      '头抬一抬，别低头太久。',
      '背靠椅背，屁股坐满椅子。',
      '两脚平放地面，坐稳再写。'
    ].join('\n')
  };

  function loadSettings(){
    try{
      const raw = localStorage.getItem('pg_settings');
      if(!raw) return {...DEFAULTS};
      const parsed = JSON.parse(raw);
      return {...DEFAULTS, ...parsed};
    }catch(e){
      return {...DEFAULTS};
    }
  }

  function saveSettings(settings){
    localStorage.setItem('pg_settings', JSON.stringify(settings));
  }

  function pickVoice(preferFemale){
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    if(!voices || !voices.length) return null;

    // 优先中文，其次任何可用
    const zh = voices.filter(v => /zh|chinese/i.test(v.lang) || /zh/i.test(v.name));
    const pool = zh.length ? zh : voices;

    if(preferFemale){
      const female = pool.find(v => /female|xiaoxiao|xiaoyi|huihui|婷婷|晓晓|小艺|小微/i.test(v.name));
      if(female) return female;
    }

    return pool[0] || null;
  }

  function speak(text, settings){
    if(!settings.ttsEnabled) return;
    if(!('speechSynthesis' in window)) return;

    try{
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = settings.ttsRate;
      u.pitch = settings.ttsPitch;
      u.volume = settings.ttsVolume;
      const v = pickVoice(settings.preferFemale);
      if(v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }catch(e){
      // ignore
    }
  }

  function formatMMSS(sec){
    const m = Math.floor(sec/60);
    const s = sec%60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function linesToArray(linesText){
    const s = String(linesText || '').replace(/\r/g, '').trim();
    if(!s) return [];
    return s.split('\n').map(x => x.trim()).filter(Boolean);
  }

  function pickRandom(arr){
    if(!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function clamp01(x){
    return Math.max(0, Math.min(1, x));
  }

  function dist2(a,b){
    const dx = (a.x - b.x);
    const dy = (a.y - b.y);
    return Math.sqrt(dx*dx + dy*dy);
  }

  function vec(a,b){
    return { x: b.x - a.x, y: b.y - a.y };
  }

  function dot(u,v){
    return u.x*v.x + u.y*v.y;
  }

  function len(u){
    return Math.sqrt(u.x*u.x + u.y*u.y);
  }

  function angleDeg(u,v){
    const du = len(u);
    const dv = len(v);
    if(du < 1e-6 || dv < 1e-6) return 0;
    const c = Math.max(-1, Math.min(1, dot(u,v) / (du*dv)));
    return Math.acos(c) * 180 / Math.PI;
  }

  function postureEvaluate(landmarks, settings){
    if(!landmarks || landmarks.length < 33) return { level: '', statusText: '未识别到人体', suggestion: '请把上半身对准镜头，保持光线充足。' };

    const s = settings || DEFAULTS;
    const sens = Math.max(0.6, Math.min(1.6, Number(s.postureSensitivity || 1.0)));

    const nose = landmarks[0];
    const lEye = landmarks[2];
    const rEye = landmarks[5];
    const lEar = landmarks[7];
    const rEar = landmarks[8];
    const lShoulder = landmarks[11];
    const rShoulder = landmarks[12];
    const lHip = landmarks[23];
    const rHip = landmarks[24];

    const shoulderWidth = dist2(lShoulder, rShoulder);
    const shoulderMid = { x: (lShoulder.x + rShoulder.x)/2, y: (lShoulder.y + rShoulder.y)/2 };
    const hipMid = { x: (lHip.x + rHip.x)/2, y: (lHip.y + rHip.y)/2 };
    const earMid = { x: (lEar.x + rEar.x)/2, y: (lEar.y + rEar.y)/2 };
    const eyeMid = { x: (lEye.x + rEye.x)/2, y: (lEye.y + rEye.y)/2 };

    const torso = vec(hipMid, shoulderMid);
    const verticalUp = { x: 0, y: -1 };

    // 越大说明躯干越不直（前趴/侧倾都会增加）
    const torsoOffVerticalDeg = angleDeg(torso, verticalUp);
    // 头前倾：耳朵中心相对肩部中心向前/向下偏移（2D 近似）
    const headForward = clamp01(((earMid.y - shoulderMid.y) - 0.02) / (0.10 / sens));
    // 低头：眼睛中心更靠下（2D 近似）
    const headDown = clamp01(((eyeMid.y - shoulderMid.y) - 0.02) / (0.12 / sens));

    // 歪头：双耳水平差（归一化到肩宽）
    const earTilt = shoulderWidth > 1e-4 ? Math.abs(lEar.y - rEar.y) / shoulderWidth : 0;
    const shoulderTilt = shoulderWidth > 1e-4 ? Math.abs(lShoulder.y - rShoulder.y) / shoulderWidth : 0;

    // “离书太近”距离估算：用肩宽在画面中的占比，基于基准 shoulderWidthRef 做相对距离估算
    const ref = Number(s.shoulderWidthRef || 0);
    const usedRef = ref > 0.0001 ? ref : 0.36;
    const distanceRatio = usedRef > 1e-4 ? (usedRef / Math.max(shoulderWidth, 1e-4)) : 1;
    // ratio 越小表示越近（肩更大）
    const tooNear = clamp01(((0.90 - distanceRatio)) / (0.18 / sens));

    // 趴桌/弓背：躯干偏离竖直 + 头前倾（组合更稳）
    const slouch = clamp01(((torsoOffVerticalDeg - 14) / (16 / sens)));
    const slouchCombo = clamp01(Math.max(slouch, headForward * 0.85));

    const tilt = clamp01(((Math.max(earTilt, shoulderTilt) - 0.06) / (0.10 / sens)));

    const score = Math.max(tooNear, headDown, tilt, slouchCombo);

    const issues = [];
    if(tooNear > 0.55) issues.push('太近');
    if(headDown > 0.55) issues.push('低头');
    if(tilt > 0.55) issues.push('歪头');
    if(slouchCombo > 0.55) issues.push('趴桌');

    let level = 'ok';
    let statusText = '坐姿良好';
    let suggestion = '保持：背挺直、肩放松、眼睛离书一拳、胸口离桌一拳、双脚平放。';

    if(score >= 0.86){
      level = 'danger';
      statusText = issues.length ? `坐姿不合格（${issues.join('、')}）` : '坐姿不合格';
      if(issues.includes('太近')){
        suggestion = '调整距离：把书本稍微推远一点，背挺直坐满椅子，眼睛离书一拳，胸口离桌一拳。';
      }else if(issues.includes('趴桌')){
        suggestion = '别趴桌：屁股坐满椅子，腰背挺直，肩放松，抬头写，肘部靠桌但胸口别贴桌。';
      }else if(issues.includes('歪头')){
        suggestion = '把头扶正：两肩同高，头不要歪，纸张摆正，左手压住本子。';
      }else if(issues.includes('低头')){
        suggestion = '抬头一点：把本子立起来一点或垫高，眼睛离书一拳，别把下巴贴近胸口。';
      }
    }else if(score >= 0.58){
      level = 'warn';
      statusText = issues.length ? `需要调整（${issues.join('、')}）` : '需要调整';
      suggestion = '轻微调整：背再挺直一点点，肩放松，纸张摆正，眼离书一拳。';
    }

    // 给 UI/日志用的辅助信息
    const debug = {
      shoulderWidth,
      distanceRatio,
      torsoOffVerticalDeg,
      earTilt,
      headForward,
      headDown,
    };

    return { level, statusText, suggestion, score, issues, debug };
  }

  function createSpeechThrottle(){
    let lastAt = 0;
    return function maybeSpeak(text, settings){
      const now = Date.now();
      const cooldownMs = Math.max(1500, Number(settings.warningCooldownSec || 6) * 1000);
      if(now - lastAt < cooldownMs) return false;
      lastAt = now;
      speak(text, settings);
      return true;
    };
  }

  window.PG = {
    DEFAULTS,
    loadSettings,
    saveSettings,
    speak,
    formatMMSS,
    linesToArray,
    pickRandom,
    postureEvaluate,
    createSpeechThrottle,
  };
})();
