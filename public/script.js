// ── State ──────────────────────────────────────────────────────────────────────
// ── Sound Engine ──────────────────────────────────────────────────────────────
let soundEnabled = true;
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudioCtx() {
    if (!audioCtx) audioCtx = new AudioCtx();
    return audioCtx;
}

function playTone(freq, type, duration, volume = 0.3, delay = 0) {
    if (!soundEnabled) return;
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gain.gain.setValueAtTime(0, ctx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + duration);
    } catch(e) {}
}

const sounds = {
    submit:   () => playTone(520, 'sine', 0.12, 0.2),
    allIn:    () => { playTone(440, 'sine', 0.1, 0.25); playTone(660, 'sine', 0.15, 0.25, 0.12); },
    reveal:   () => { [300,400,500,660].forEach((f,i) => playTone(f, 'sine', 0.18, 0.2, i*0.08)); },
    correct:  () => { [523,659,784].forEach((f,i) => playTone(f, 'triangle', 0.2, 0.3, i*0.1)); },
    fooled:   () => { [400,300,200].forEach((f,i) => playTone(f, 'sawtooth', 0.1, 0.15, i*0.1)); },
    end:      () => { [523,659,784,1047].forEach((f,i) => playTone(f, 'sine', 0.3, 0.35, i*0.12)); },
};


let myRoomId    = null;
let amIHost     = false;
let myLastAnswer = '';
let currentPhase = 'LANDING';
let currentRound = 0;
let maxRounds    = 0;
let currentRevealData = null;
let currentQuestion   = '';
let gameMode = 'digital'; // 'digital' | 'presence'
let selectedMode       = 'digital';
let selectedCategories = [];
let timerTotal = 90;
let WRITE_SECS = 90;
let VOTE_SECS  = 60;

// ── DOM ────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const landingSection   = $('landing-section');
const gameRoomSection  = $('game-room-section');
const gameHeader       = $('game-header');

const phaseLobby      = $('phase-lobby');
const phaseWriting    = $('phase-writing');
const phaseVoting     = $('phase-voting');
const phaseReveal     = $('phase-reveal');
const phaseEndResults = $('phase-end-results');

const hostControls      = $('host-controls');
const btnStartGame      = $('btn-start-game');
const btnStartVoting    = $('btn-start-voting');
const btnRevealAnswer   = $('btn-reveal-answer');
const btnRevealAuthors  = $('btn-reveal-authors');
const btnVeto           = $('btn-veto');
const btnStartNextRound = $('btn-start-next-round');

const playerList     = $('player-list');
const questionText   = $('question-text');
const myAnswerInput  = $('my-answer-input');
const waitingMessage = $('waiting-message');
const votingOptions  = $('voting-options');
const roundCounter   = $('round-counter');
const timerBarWrap   = $('timer-bar-wrap');
const timerBar       = $('timer-bar');
const timerText      = $('timer-text');

// ── Socket ─────────────────────────────────────────────────────────────────────
const socket = io({ reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000, timeout: 20000 });

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function showSection(id) {
    landingSection.classList.add('hidden');
    gameRoomSection.classList.add('hidden');
    $('join-dialog').classList.add('hidden');
    $(id).classList.remove('hidden');
    if (id === 'game-room-section') gameHeader.classList.remove('hidden');
}

function showPhase(id) {
    ['phase-lobby','phase-writing','phase-voting','phase-reveal','phase-end-results']
        .forEach(p => $(p).classList.add('hidden'));
    $(id).classList.remove('hidden');
}

function hideAllHostBtns() {
    [btnStartGame, btnStartVoting, btnRevealAuthors, btnRevealAnswer, btnStartNextRound, btnVeto]
        .forEach(b => b.classList.add('hidden'));
}

function updatePlayerListUI(players) {
    if (!players) return;
    playerList.innerHTML = '';
    players.forEach((p, i) => {
        const li = document.createElement('li');
        if (p.isOffline) li.classList.add('offline');
        const star = i === 0 ? '⭐ ' : '';
        let tick = '';
        if (currentPhase === 'WRITING' && p.currentAnswer) tick = '✔';
        if (currentPhase === 'VOTING'  && p.votedFor)      tick = '✔';
        li.innerHTML = `<span>${star}${p.name}</span>
                        <span>${p.points || 0} Pkt <span class="tick-mark">${tick}</span></span>`;
        playerList.appendChild(li);
    });

    // Host: Beenden-Button
    if (amIHost) {
        const endBtn = document.createElement('button');
        endBtn.innerText = 'Spiel beenden';
        endBtn.className = 'btn neon-btn-plain';
        endBtn.style.cssText = 'font-size:0.7rem;margin-top:12px;opacity:0.5;';
        endBtn.onclick = () => { if (confirm('Spiel wirklich für alle beenden?')) socket.emit('forceEndGame', myRoomId); };
        playerList.appendChild(endBtn);
    }
}

function updateTimer(phase, remaining) {
    const total = phase === 'WRITING' ? timerTotal : 60;
    timerBarWrap.classList.remove('hidden');
    const pct = (remaining / total) * 100;
    timerBar.style.width = pct + '%';
    timerText.textContent = remaining;
    const urgent = remaining <= 15;
    timerBar.classList.toggle('urgent', urgent);
    timerText.classList.toggle('urgent', urgent);
}

function hideTimer() {
    timerBarWrap.classList.add('hidden');
    timerBar.style.width = '100%';
    timerBar.classList.remove('urgent');
    timerText.classList.remove('urgent');
}

function generateQR(roomId) {
    const qrEl = $('qr-code');
    qrEl.innerHTML = '';
    const url = `${window.location.origin}?room=${roomId}`;
    new QRCode(qrEl, { text: url, width: 120, height: 120, colorDark: '#00d2ff', colorLight: '#0f172a' });
    // QR startet sichtbar in der Lobby, wird beim Spielstart versteckt
    $('qr-container').classList.remove('hidden');
}

function toggleQR() {
    const qr = $('qr-container');
    const nowHidden = qr.classList.toggle('hidden');
    $('btn-sidebar-qr').classList.toggle('muted', nowHidden);
}

// ── Reveal: Schrittweises Aufdecken ───────────────────────────────────────────

// Schritt 1: Alle Antworten anzeigen – mit Wählern, aber ohne Autoren
function renderRevealStep1(data) {
    const container = $('voting-distribution');
    container.innerHTML = '';

    data.shuffledAnswers.forEach((ans, i) => {
        const voters = data.players.filter(p => p.votedFor === ans.text).map(p => p.name);
        const card = document.createElement('div');
        card.className = 'answer-reveal-card neon-border-blue';
        card.dataset.answerText = ans.text;
        card.dataset.creatorId  = ans.creator;
        card.dataset.isCorrect  = ans.isCorrect;
        card.style.animationDelay = (i * 0.1) + 's';
        card.innerHTML = `
            <div class="reveal-answer-text">${ans.text}</div>
            <div class="reveal-voters">${voters.length ? '👆 ' + voters.join(', ') : '<span style="opacity:0.4">Keine Stimmen</span>'}</div>
            <div class="reveal-author-placeholder"></div>`;
        container.appendChild(card);
    });
}

// Schritt 2: Autoren aufdecken
function renderRevealStep2(data) {
    document.querySelectorAll('.answer-reveal-card').forEach((card, i) => {
        setTimeout(() => {
            const creatorId = card.dataset.creatorId;
            const placeholder = card.querySelector('.reveal-author-placeholder');
            if (creatorId === 'SERVER') {
                placeholder.innerHTML = '';
            } else {
                const player = data.players.find(p => p.id === creatorId);
                const name = player ? player.name : '?';
                placeholder.innerHTML = `<span class="author-info">✍️ Von: ${name}</span>`;
            }
        }, i * 220);
    });
}

// Schritt 3: Richtige Antwort markieren + Punkte
function renderRevealStep3(data) {
    // Guard: nur einmal ausführen
    if ($('voting-distribution').querySelector('.reveal-correct')) return;

    btnRevealAnswer.classList.add('hidden');
    btnRevealAuthors.classList.add('hidden');

    document.querySelectorAll('.answer-reveal-card').forEach(card => {
        if (card.dataset.answerText === data.correctAnswer) {
            card.classList.remove('neon-border-blue');
            card.classList.add('reveal-correct');
            const badge = document.createElement('div');
            badge.style.cssText = 'color:var(--neon-green);font-weight:bold;font-size:0.85rem;margin-top:6px;';
            badge.textContent = '★ RICHTIGE ANTWORT ★';
            card.prepend(badge);
        } else {
            card.style.opacity = '0.5';
        }
    });

    updatePlayerListUI(data.players);

    // Präsenz: Wissenden + wahre Antwort jetzt aufdecken
    if (data.knowerName) {
        const knowerEl = $('reveal-question-display');
        knowerEl.innerHTML = currentQuestion +
            `<div class="knower-badge" style="display:block;text-align:center;margin-top:10px;animation:fadeIn 0.5s ease;">🎯 ${data.knowerName} kannte die Antwort · Wahre Antwort: <em>${data.trueAnswer || ''}</em></div>`;
    }

    // Punktezusammenfassung
    const summary = $('round-summary');
    const grid    = $('round-points-grid');
    summary.classList.remove('hidden');
    grid.innerHTML = '';
    data.players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'simple-point-row';
        const col = p.roundPoints > 0 ? 'var(--neon-green)' : '#888';
        row.innerHTML = `<span>${p.name}</span>
                         <span style="color:${col};font-weight:bold;">${p.roundPoints > 0 ? '+' : ''}${p.roundPoints} Pkt</span>`;
        grid.appendChild(row);
    });

    // Host: Nächste Runde + ggf. Veto
    if (amIHost) {
        btnStartNextRound.classList.remove('hidden');
        const isLast = maxRounds > 0 && currentRound >= maxRounds;
        btnStartNextRound.textContent = isLast ? '🏆 Zur Siegerehrung' : 'Nächste Runde →';
        btnStartNextRound.onclick = () => {
            btnStartNextRound.classList.add('hidden');
            btnVeto.classList.add('hidden');
            if (isLast) socket.emit('forceEndGame', myRoomId);
            else        socket.emit('nextQuestion', myRoomId);
        };

        // Veto nur im Präsenz-Modus
        if (gameMode === 'presence') {
            btnVeto.classList.remove('hidden');
        }
    }
}

// ── Landing: Buttons ───────────────────────────────────────────────────────────
$('btn-create-room').onclick = () => {
    $('create-dialog').classList.toggle('hidden');
    $('join-dialog').classList.add('hidden');
};
$('btn-show-join').onclick = () => {
    $('join-dialog').classList.toggle('hidden');
    $('create-dialog').classList.add('hidden');
};
$('btn-create-cancel').onclick = () => $('create-dialog').classList.add('hidden');
$('btn-join-cancel').onclick   = () => $('join-dialog').classList.add('hidden');
$('btn-help').onclick          = () => $('rules-modal').classList.remove('hidden');
$('btn-close-rules').onclick   = () => $('rules-modal').classList.add('hidden');

// Modus-Buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;
    };
});

// ── Kategorien ─────────────────────────────────────────────────────────────────
socket.on('categoriesAvailable', (cats) => {
    const grid = $('category-buttons');
    grid.innerHTML = '';
    cats.forEach(cat => {
        const pill = document.createElement('button');
        pill.className = 'btn cat-pill';
        pill.textContent = cat;
        pill.onclick = () => {
            pill.classList.toggle('selected');
            selectedCategories = [...document.querySelectorAll('.cat-pill.selected')].map(p => p.textContent);
        };
        grid.appendChild(pill);
    });
});

// ── Raum erstellen ─────────────────────────────────────────────────────────────
$('btn-create-confirm').onclick = () => {
    const name       = $('create-name-input').value.trim();
    const code       = $('create-code-input').value.trim();
    const rounds     = parseInt($('create-rounds-input').value) || 0;
    const writeTimer = Math.max(10, parseInt($('create-write-timer').value) || 90);
    const voteTimer  = Math.max(10, parseInt($('create-vote-timer').value)  || 60);
    soundEnabled = $('create-sound-toggle').checked;
    if (!name) { alert('Bitte Namen eingeben!'); return; }

    localStorage.setItem('bluffIt_name', name);
    socket.emit('createRoom', {
        playerName: name,
        customCode: code,
        maxRounds: rounds,
        categories: selectedCategories,
        mode: selectedMode,
        writeTimer,
        voteTimer,
    });
};

socket.on('roomCreated', ({ roomId, players, maxRounds: mr, mode, writeTimer, voteTimer }) => {
    myRoomId   = roomId;
    amIHost    = true;
    maxRounds  = mr;
    gameMode   = mode;
    WRITE_SECS = writeTimer || 90;
    VOTE_SECS  = voteTimer  || 60;
    localStorage.setItem('bluffIt_room', roomId);

    $('room-code-display').textContent = roomId;
    $('lobby-qr-hint').classList.remove('hidden');

    // Mode badge
    const badge = $('mode-badge');
    badge.textContent = mode === 'presence' ? '🗣️ Präsenz-Modus' : '📱 Digital-Modus';
    badge.className = `mode-badge ${mode}`;

    updatePlayerListUI(players);
    showSection('game-room-section');
    showPhase('phase-lobby');

    hostControls.classList.remove('hidden');
    hideAllHostBtns();
    btnStartGame.classList.remove('hidden');

    $('btn-sidebar-qr').classList.remove('hidden');
    generateQR(roomId);
});

// ── QR-Toggle ─────────────────────────────────────────────────────────────────
$('btn-toggle-qr').onclick = toggleQR;

// ── Beitreten ──────────────────────────────────────────────────────────────────
$('btn-join-confirm').onclick = joinRoom;
function joinRoom() {
    const name = $('join-name-input').value.trim();
    const room = $('join-code-input').value.trim().toUpperCase();
    if (!name || !room) { alert('Name und Raum-Code eingeben!'); return; }
    localStorage.setItem('bluffIt_name', name);
    localStorage.setItem('bluffIt_room', room);
    socket.emit('joinRoom', { roomId: room, playerName: name });
}

socket.on('joinedSuccess', (roomId) => {
    myRoomId = roomId;
    $('room-code-display').textContent = roomId;
    showSection('game-room-section');
    showPhase('phase-lobby');
});

// ── Reconnect ──────────────────────────────────────────────────────────────────
socket.on('connect', () => {
    const name = localStorage.getItem('bluffIt_name');
    const room = localStorage.getItem('bluffIt_room');
    if (name && room && currentPhase !== 'LANDING') {
        socket.emit('joinRoom', { roomId: room, playerName: name });
    }
});

window.addEventListener('load', () => {
    const name = localStorage.getItem('bluffIt_name');
    const room = localStorage.getItem('bluffIt_room');
    if (name && room) {
        socket.emit('joinRoom', { roomId: room, playerName: name });
    }

    // ?room= Parameter im URL auto-ausfüllen
    const urlRoom = new URLSearchParams(window.location.search).get('room');
    if (urlRoom) $('join-code-input').value = urlRoom;
});

socket.on('initRejoin', (data) => {
    if (data.writeTimer) WRITE_SECS = data.writeTimer;
    if (data.voteTimer)  VOTE_SECS  = data.voteTimer;
    currentPhase  = data.phase;
    currentRound  = data.currentRound;
    maxRounds     = data.maxRounds;
    myLastAnswer  = data.myLastAnswer;
    gameMode      = data.mode || 'digital';

    if (data.phase === 'WRITING') {
        currentQuestion = data.currentQuestion;
        questionText.textContent = data.currentQuestion;
        $('digital-answer-area').classList.toggle('hidden', gameMode === 'presence');
        if (data.alreadySubmitted) {
            myAnswerInput.disabled = true;
            $('btn-submit-answer').classList.add('hidden');
            waitingMessage.classList.remove('hidden');
        }
        showSection('game-room-section');
        showPhase('phase-writing');
    } else if (data.phase === 'VOTING') {
        showSection('game-room-section');
        showPhase('phase-voting');
        $('voting-question-display').textContent = currentQuestion;
        const grid = $('voting-options');
        grid.innerHTML = '';
        data.shuffledAnswers.forEach((text, i) => {
            const btn = buildVoteBtn(text);
            grid.appendChild(btn);
            setTimeout(() => btn.classList.add('visible'), i * 150);
        });
    }
});

// ── Spielerliste Update ────────────────────────────────────────────────────────
socket.on('updatePlayerList', (players) => {
    updatePlayerListUI(players);
});

// ── Host: Spiel starten ────────────────────────────────────────────────────────
btnStartGame.onclick = () => {
    socket.emit('nextQuestion', myRoomId);
    hideAllHostBtns();
};

// ── Neue Frage ─────────────────────────────────────────────────────────────────
socket.on('newQuestion', ({ question, category, currentRound: r, maxRounds: mr, mode }) => {
    currentRound    = r;
    maxRounds       = mr;
    currentPhase    = 'WRITING';
    currentQuestion = question;
    gameMode        = mode;

    roundCounter.textContent = mr > 0 ? `${r}/${mr}` : `Runde ${r}`;

    questionText.textContent = question;
    myAnswerInput.value      = '';
    myAnswerInput.disabled   = false;
    $('btn-submit-answer').classList.remove('hidden');
    waitingMessage.classList.add('hidden');

    // Category badge
    const cb = $('category-badge');
    cb.textContent = category || '';
    cb.style.display = category ? '' : 'none';

    const isPresence = mode === 'presence';
    $('presence-answer-reveal').classList.add('hidden');
    $('presence-watcher-info').classList.add('hidden');

    if (isPresence) {
        // Präsenz: Input erst verstecken – wird sichtbar wenn klar ist wer der Wissende ist
        $('digital-answer-area').classList.add('hidden');
        myAnswerInput.placeholder = 'Erfinde deine glaubwürdige Bluff-Antwort…';
    } else {
        $('digital-answer-area').classList.remove('hidden');
    }

    // Host-Controls: Im Präsenz-Modus KEIN Button sofort – erst wenn alle abgegeben haben
    if (amIHost) {
        hideAllHostBtns();
        // btnStartVoting kommt erst wenn allAnswersIn oder der Wissende bin ich selbst
    }

    // Reveal-Container zurücksetzen
    $('voting-distribution')._rendered = false;
    $('round-summary').classList.add('hidden');

    showPhase('phase-writing');
    hideTimer();
    $('reaction-panel').classList.add('hidden');
    // QR nach Spielstart verstecken
    $('qr-container').classList.add('hidden');
    $('lobby-qr-hint').classList.add('hidden');
});

// ── Präsenz: Du hast die Antwort ──────────────────────────────────────────────
socket.on('youHaveTheAnswer', ({ answer }) => {
    $('presence-answer-reveal').classList.remove('hidden');
    $('presence-answer-text').textContent = answer;
    $('digital-answer-area').classList.add('hidden');
    waitingMessage.classList.add('hidden');
    // Wissender formuliert seine Antwort selbst – zeige eigenes Tipfeld
    // mit der richtigen Antwort als Hinweis, aber leer zum Selbst-Formulieren
    myAnswerInput.value = '';
    myAnswerInput.placeholder = `Formuliere die Antwort in deinen Worten (Antwort: ${answer})`;
    myAnswerInput.disabled = false;
    $('btn-submit-answer').classList.remove('hidden');
    $('btn-submit-answer').textContent = '✅ Antwort abschicken';
    $('digital-answer-area').classList.remove('hidden');
    // Host-Button "Abstimmung starten" noch nicht zeigen – erst wenn alle abgegeben
});

// ── Präsenz: Wer hat die Antwort ──────────────────────────────────────────────
socket.on('presencePlayerChosen', () => {
    // Nur sagen dass jemand die Antwort hat - nicht wer!
    $('presence-watcher-info').classList.remove('hidden');
    $('presence-chosen-name').textContent = '🎯 Ein Spieler kennt die richtige Antwort. Alle anderen bluffen!';
    myAnswerInput.value = '';
    myAnswerInput.disabled = false;
    myAnswerInput.placeholder = 'Erfinde deine glaubwürdige Bluff-Antwort…';
    $('btn-submit-answer').classList.remove('hidden');
    $('btn-submit-answer').textContent = '✅ Antwort abschicken';
    waitingMessage.classList.add('hidden');
    $('digital-answer-area').classList.remove('hidden');
});

// ── Antwort abschicken ─────────────────────────────────────────────────────────
$('btn-submit-answer').onclick = () => {
    const text = myAnswerInput.value.trim();
    if (!text) { alert('Bitte eine Antwort eingeben!'); return; }
    myLastAnswer = text;
    sounds.submit();
    socket.emit('submitAnswer', { roomId: myRoomId, answer: text });
    myAnswerInput.disabled = true;
    $('btn-submit-answer').classList.add('hidden');
    waitingMessage.classList.remove('hidden');
};

// ── Host: Abstimmung starten (Präsenz) ────────────────────────────────────────
btnStartVoting.onclick = () => {
    socket.emit('startVoting', myRoomId);
    hideAllHostBtns();
};

// allAnswersIn wird nicht mehr gebraucht - Voting startet automatisch

// ── Jemand hat abgeschickt ─────────────────────────────────────────────────────
socket.on('playerSubmitted', (socketId) => {
    // Tick wird über updatePlayerList gesetzt
});

// ── Timer Updates ──────────────────────────────────────────────────────────────
socket.on('timerUpdate', ({ phase, remaining }) => {
    timerTotal = phase === 'WRITING' ? WRITE_SECS : VOTE_SECS;
    updateTimer(phase, remaining);
});

// ── Voting Phase ───────────────────────────────────────────────────────────────
socket.on('showVotingOptions', ({ answers, question }) => {
    currentPhase = 'VOTING';
    hideTimer();
    sounds.allIn();

    $('voting-question-display').textContent = question || currentQuestion;
    $('vote-waiting-msg').classList.add('hidden');
    votingOptions.innerHTML = '';

    answers.forEach((item, i) => {
        // item ist entweder {text, authorName} oder ein reiner String (Fallback)
        const text       = typeof item === 'object' ? item.text : item;
        const authorName = typeof item === 'object' ? item.authorName : null;
        const isOwn      = text === myLastAnswer;
        const btn = buildVoteBtn(text, isOwn, authorName);
        votingOptions.appendChild(btn);
        setTimeout(() => btn.classList.add('visible'), i * 160);
    });

    showPhase('phase-voting');
    if (amIHost) { hideAllHostBtns(); }
});

let voteCountdown = null; // Globaler Countdown-Timer

function buildVoteBtn(text, isOwn = false, authorName = null) {
    const btn = document.createElement('button');
    btn.className = 'btn answer-option-btn ' + (isOwn ? 'answer-own' : 'neon-btn-blue');

    const authorTag = authorName
        ? `<span class="vote-author-tag">✍️ ${authorName}</span>`
        : '';

    if (isOwn) {
        btn.innerHTML = `${text}${authorTag}<span class="own-badge">Deine Antwort</span>`;
        btn.disabled = true;
        btn.title = 'Du kannst nicht für deine eigene Antwort stimmen.';
    } else {
        btn.innerHTML = text + authorTag;
        btn.onclick = () => {
            // Bereits gesperrt?
            if (btn.dataset.locked === 'true') return;

            // Vorherige Auswahl zurücksetzen
            document.querySelectorAll('.answer-option-btn.selected').forEach(b => {
                b.classList.remove('selected');
                b.textContent = b.dataset.origText || b.textContent.replace(/ \(\d+s\)$/, '');
            });

            btn.dataset.origText = text;
            btn.classList.add('selected');
            sounds.submit();
            socket.emit('submitVote', { roomId: myRoomId, answerText: text });
            $('vote-waiting-msg').classList.remove('hidden');

            // Countdown starten / neu starten
            clearInterval(voteCountdown);
            let secs = 5;
            btn.innerHTML = `${text} (${secs}s)` + authorTag;
            voteCountdown = setInterval(() => {
                secs--;
                if (secs <= 0) {
                    clearInterval(voteCountdown);
                    document.querySelectorAll('.answer-option-btn:not(.answer-own)').forEach(b => {
                        b.dataset.locked = 'true';
                        b.style.opacity = b.classList.contains('selected') ? '1' : '0.4';
                    });
                    btn.innerHTML = text + authorTag;
                    socket.emit('lockVote', myRoomId);
                } else {
                    btn.innerHTML = `${text} (${secs}s)` + authorTag;
                }
            }, 1000);
        };
    }
    return btn;
}

// ── Reveal ─────────────────────────────────────────────────────────────────────
socket.on('resultsRevealed', (data) => {
    currentPhase       = 'REVEAL';
    currentRevealData  = data;
    hideTimer();

    $('reveal-question-display').textContent = currentQuestion;
    $('round-summary').classList.add('hidden');

    // Nur Frage anzeigen – Badge kommt erst beim Aufdecken
    $('reveal-question-display').textContent = currentQuestion;

    // Button-Text immer setzen (auch für spätere Hosts)
    btnRevealAuthors.textContent = data.knowerName ? '👤 Autoren aufdecken' : '🎯 Auflösung';
    btnRevealAnswer.textContent  = '✅ Richtige Antwort aufdecken';

    if (amIHost) {
        hideAllHostBtns();
        if (data.knowerName) {
            // Präsenz: direkt "Richtige Antwort aufdecken" (Autoren kommen automatisch)
        } else {
            // Digital: ein Button macht alles
            btnRevealAuthors.classList.remove('hidden');
        }
    }

    showPhase('phase-reveal');
    $('reaction-panel').classList.remove('hidden');
    sounds.reveal();

    renderRevealStep1(data);

    // Präsenz-Modus: Autoren sofort einblenden
    if (data.knowerName) {
        setTimeout(() => {
            renderRevealStep2(data);
            if (amIHost) {
                btnRevealAuthors.classList.add('hidden');
                btnRevealAnswer.classList.remove('hidden');
            }
        }, 600);
    }
});

// Host: Auflösung (Digital) oder Autoren aufdecken (Präsenz)
btnRevealAuthors.onclick = () => {
    btnRevealAuthors.classList.add('hidden');
    if (currentRevealData && currentRevealData.knowerName) {
        // Präsenz: Autoren aufdecken
        socket.emit('triggerShowAuthors', myRoomId);
    } else {
        // Digital: richtige Antwort + Autoren
        socket.emit('triggerHighlightCorrect', myRoomId);
    }
};

// Host: Richtige Antwort aufdecken (Schritt 3) - nur Präsenz-Modus
btnRevealAnswer.onclick = () => {
    socket.emit('triggerHighlightCorrect', myRoomId);
    btnRevealAnswer.classList.add('hidden');
};

socket.on('showAuthors', () => {
    // Nur im Präsenz-Modus genutzt
    renderRevealStep2(currentRevealData);
    if (amIHost && !$('voting-distribution').querySelector('.reveal-correct')) {
        btnRevealAnswer.classList.remove('hidden');
    }
});

socket.on('highlightCorrectAnswer', () => {
    sounds.correct();
    renderRevealStep3(currentRevealData);
    btnRevealAnswer.classList.add('hidden');
    btnRevealAuthors.classList.add('hidden');

    // Digital: Autoren mit leichter Verzögerung einblenden
    if (gameMode !== 'presence') {
        setTimeout(() => renderRevealStep2(currentRevealData), 400);
    }
});

// ── youAreHost ─────────────────────────────────────────────────────────────────
socket.on('youAreHost', () => {
    amIHost = true;
    hostControls.classList.remove('hidden');
    $('btn-sidebar-qr').classList.remove('hidden');
    hideAllHostBtns();

    // Phasengerechte Buttons einblenden
    if (currentPhase === 'LOBBY') {
        btnStartGame.classList.remove('hidden');
    } else if (currentPhase === 'WRITING') {
        if (gameMode === 'presence') btnStartVoting.classList.remove('hidden');
        // Im Digital-Modus läuft der Timer automatisch – kein Button nötig
    } else if (currentPhase === 'VOTING') {
        // Voting läuft automatisch – kein Button nötig
    } else if (currentPhase === 'REVEAL') {
        // Wenn richtige Antwort noch nicht aufgedeckt wurde
        if (!$('voting-distribution').querySelector('.reveal-correct')) {
            btnRevealAnswer.classList.remove('hidden');
        } else {
            // Antwort schon aufgedeckt -> direkt "Nächste Runde" zeigen
            btnStartNextRound.classList.remove('hidden');
            const isLast = maxRounds > 0 && currentRound >= maxRounds;
            btnStartNextRound.textContent = isLast ? '🏆 Zur Siegerehrung' : 'Nächste Runde →';
            btnStartNextRound.onclick = () => {
                btnStartNextRound.classList.add('hidden');
                if (isLast) socket.emit('forceEndGame', myRoomId);
                else socket.emit('nextQuestion', myRoomId);
            };
        }
    }

    alert('Der Host hat das Spiel verlassen. Du bist jetzt der neue Host!');
});

// ── Spielende ──────────────────────────────────────────────────────────────────
socket.on('gameEnded', ({ players, stats }) => {
    currentPhase = 'END';
    hideTimer();
    hostControls.classList.add('hidden');
    gameHeader.classList.add('hidden');
    sounds.end();
    showPhase('phase-end-results');
    $('reaction-panel').classList.remove('hidden');

    // Awards
    const awardsEl = $('awards-section');
    if (stats && stats.length) {
        awardsEl.innerHTML = `<div class="awards-title">🏅 Awards</div>` +
            stats.map((s, i) => `
                <div class="award-item" style="animation-delay:${0.3 + i*0.15}s">
                    <div class="award-emoji">${s.emoji}</div>
                    <div class="award-text">
                        <div class="award-title">${s.title}</div>
                        <div class="award-name">${s.name}</div>
                        <div class="award-value">${s.value}</div>
                    </div>
                </div>`).join('');
    } else {
        awardsEl.innerHTML = '';
    }

    const sorted = [...players].sort((a, b) => b.points - a.points);
    const podium = $('podium-list');
    podium.innerHTML = '';
    sorted.forEach((p, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:16px 20px;margin:10px 0;background:rgba(20,20,20,0.8);border-radius:10px;border:1px solid #333;animation:slideUp 0.4s ease both;';
        row.style.animationDelay = (i * 0.1) + 's';
        const rank = ['👑 1.','🥈 2.','🥉 3.'][i] || `${i+1}.`;
        row.innerHTML = `<span style="font-size:1.3rem;font-weight:bold;">${rank} ${p.name}</span>
                         <span style="font-size:1.3rem;color:var(--neon-green);font-weight:bold;">${p.points} Pkt</span>`;
        podium.appendChild(row);
    });

    const rematchBtn = $('btn-rematch');
    if (amIHost) rematchBtn.classList.remove('hidden');
    rematchBtn.onclick = () => socket.emit('rematch', myRoomId);
});

socket.on('rematchStarted', (players) => {
    currentPhase = 'LOBBY';
    updatePlayerListUI(players);
    gameHeader.classList.remove('hidden');
    showSection('game-room-section');
    showPhase('phase-lobby');
    hideTimer();
    if (amIHost) {
        hostControls.classList.remove('hidden');
        hideAllHostBtns();
        btnStartGame.classList.remove('hidden');
    }
});

// ── Veto ───────────────────────────────────────────────────────────────────────
btnVeto.onclick = () => {
    // Spielerliste im Overlay aufbauen (ohne den Wissenden falls bekannt)
    const overlay = $('veto-overlay');
    const list    = $('veto-player-list');
    list.innerHTML = '';
    const players = currentRevealData ? currentRevealData.players : [];
    players.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'veto-player-btn';
        btn.innerHTML = `<strong>${p.name}</strong> <span style="color:#778;font-size:0.8rem;">(+${Math.max(0, p.roundPoints)} Pkt diese Runde)</span>`;
        btn.onclick = () => {
            if (!confirm(`Wirklich ${p.name} bestrafen? Er/Sie verliert doppelte Rundengewinne.`)) return;
            socket.emit('vetoPlayer', { roomId: myRoomId, playerName: p.name });
            overlay.classList.add('hidden');
        };
        list.appendChild(btn);
    });
    overlay.classList.remove('hidden');
};

$('btn-veto-cancel').onclick = () => $('veto-overlay').classList.add('hidden');

socket.on('vetoed', ({ playerName, penalty, players }) => {
    updatePlayerListUI(players);
    // Punkte im Round-Summary aktualisieren
    const grid = $('round-points-grid');
    if (grid) {
        grid.querySelectorAll('.simple-point-row').forEach(row => {
            if (row.querySelector('span')?.textContent === playerName) {
                row.style.animation = 'pulse 0.5s';
            }
        });
    }
    // Kurze Anzeige
    const msg = document.createElement('div');
    msg.style.cssText = 'text-align:center;color:#ff9500;font-weight:bold;margin-top:10px;animation:fadeIn 0.3s ease;';
    msg.textContent = `⚠️ ${playerName} hat -${penalty} Punkte bekommen!`;
    $('round-summary').appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
});

// ── Reaktionen ────────────────────────────────────────────────────────────────
document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => {
        const emoji = btn.dataset.emoji;
        socket.emit('sendReaction', { roomId: myRoomId, emoji });
    };
});

socket.on('reaction', ({ name, emoji }) => {
    const overlay = $('reaction-overlay');
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    // Zufällige horizontale Position
    const x = 10 + Math.random() * 80;
    const startY = 60 + Math.random() * 30;
    el.style.left = x + '%';
    el.style.bottom = startY + '%';
    el.innerHTML = `${emoji}<span class="reaction-name">${name}</span>`;
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 2600);
});

// ── Sidebar Tools ─────────────────────────────────────────────────────────────
// Sound Toggle
$('btn-toggle-sound').onclick = () => {
    soundEnabled = !soundEnabled;
    const btn = $('btn-toggle-sound');
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);
};

// QR Toggle (während Spiel)
$('btn-sidebar-qr').onclick = toggleQR;

// ── Raum verlassen ────────────────────────────────────────────────────────────
$('btn-leave-room').onclick = () => {
    if (!confirm('Raum wirklich verlassen?')) return;
    socket.emit('leaveRoom');
};

socket.on('leftRoom', () => {
    localStorage.removeItem('bluffIt_name');
    localStorage.removeItem('bluffIt_room');
    location.reload();
});

// ── PWA Service Worker ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}

// ── Fehler ─────────────────────────────────────────────────────────────────────
socket.on('error', (msg) => {
    alert(msg);
    if (msg === 'Raum nicht gefunden') {
        localStorage.removeItem('bluffIt_name');
        localStorage.removeItem('bluffIt_room');
        location.reload();
    }
});
