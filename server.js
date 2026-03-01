const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ── Fragen laden & Kategorien aufbauen ────────────────────────────────────────
let allQuestions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));

// Jedem Fragen-Objekt eine Kategorie geben falls nicht vorhanden -> 'Allgemein'
allQuestions = allQuestions.map(q => ({ ...q, category: q.category || 'Allgemein' }));

const availableCategories = [...new Set(allQuestions.map(q => q.category))];

// ── Räume & Spieler ───────────────────────────────────────────────────────────
let rooms = {};
let players = new Map();
const disconnectTimeouts = {};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function getQuestionsForRoom(room) {
    let pool = allQuestions;
    if (room.categories && room.categories.length > 0) {
        pool = allQuestions.filter(q => room.categories.includes(q.category));
    }
    if (pool.length === 0) pool = allQuestions; // Fallback
    return pool;
}

function pickQuestion(room) {
    const pool = getQuestionsForRoom(room);
    const remaining = pool.filter(q => !room.usedQuestionIds.has(q.question));
    // Wenn alle durch -> used-Liste leeren und von vorne
    if (remaining.length === 0) {
        room.usedQuestionIds.clear();
        return shuffle(pool)[0];
    }
    return shuffle(remaining)[0];
}

function leaveRoom(socketId) {
    const player = players.get(socketId);
    if (!player) return;
    const roomId = player.roomId;
    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socketId);
    players.delete(socketId);

    if (room.players.length === 0) {
        clearRoomTimers(room);
        delete rooms[roomId];
    } else {
        if (room.host === socketId) {
            room.host = room.players[0].id;
            io.to(room.host).emit('youAreHost');
        }
        io.to(roomId).emit('updatePlayerList', cleanPlayers(room.players));
    }
}

function clearRoomTimers(room) {
    if (room.writeTimer) { clearInterval(room.writeTimer); room.writeTimer = null; }
    if (room.voteTimer)  { clearInterval(room.voteTimer);  room.voteTimer  = null; }
}

// ── Timer-Logik ───────────────────────────────────────────────────────────────
const WRITE_SECONDS = 90;
const VOTE_SECONDS  = 60;

function startWriteTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    clearRoomTimers(room);
    let remaining = room.writeSecs || WRITE_SECONDS;
    io.to(roomId).emit('timerUpdate', { phase: 'WRITING', remaining });
    room.writeTimer = setInterval(() => {
        remaining--;
        io.to(roomId).emit('timerUpdate', { phase: 'WRITING', remaining });
        if (remaining <= 0) {
            clearInterval(room.writeTimer);
            room.writeTimer = null;
            // Fehlende Antworten auffüllen
            room.players.forEach(p => {
                if (!p.currentAnswer) p.currentAnswer = '🤷';
            });
            startVotingPhase(roomId);
        }
    }, 1000);
}

function startVoteTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.voteTimer) clearInterval(room.voteTimer);
    let remaining = room.voteSecs || VOTE_SECONDS;
    io.to(roomId).emit('timerUpdate', { phase: 'VOTING', remaining });
    room.voteTimer = setInterval(() => {
        remaining--;
        io.to(roomId).emit('timerUpdate', { phase: 'VOTING', remaining });
        if (remaining <= 0) {
            clearInterval(room.voteTimer);
            room.voteTimer = null;
            // Fehlende Votes auffüllen mit zufälliger Antwort
            room.players.forEach(p => {
                if (!p.votedFor) {
                    const opts = room.shuffledAnswers.filter(a => a.text !== p.currentAnswer);
                    if (opts.length) p.votedFor = opts[Math.floor(Math.random() * opts.length)].text;
                }
            });
            doReveal(roomId);
        }
    }, 1000);
}

// ── Voting & Reveal ───────────────────────────────────────────────────────────
function startVotingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.phase = 'VOTING';

    let allAnswers = [];

    if (room.mode === 'presence') {
        // Im Präsenz-Modus: Wissender hat seine eigene Formulierung abgeschickt
        // → seine Antwort ist die "richtige", nicht der rohe Antworttext
        room.players.forEach(p => {
            if (!p.currentAnswer) return;
            const isKnower = p.id === room.lastPresencePlayerId;
            allAnswers.push({ text: p.currentAnswer, isCorrect: isKnower, creator: p.id });
        });
    } else {
        allAnswers = [{ text: room.currentQuestion.answer, isCorrect: true, creator: 'SERVER' }];
        room.players.forEach(p => {
            if (p.currentAnswer && p.currentAnswer !== room.currentQuestion.answer) {
                allAnswers.push({ text: p.currentAnswer, isCorrect: false, creator: p.id });
            }
        });
    }

    room.shuffledAnswers = shuffle(allAnswers);

    const answersPayload = room.shuffledAnswers.map(a => {
        if (room.mode === 'presence') {
            return {
                text: a.text,
                authorName: room.players.find(p => p.id === a.creator)?.name || null,
            };
        }
        return a.text; // Digital: nur Text
    });

    io.to(roomId).emit('showVotingOptions', {
        answers: answersPayload,
        question: room.currentQuestion.question,
    });

    startVoteTimer(roomId);
}

function doReveal(roomId) {
    const room = rooms[roomId];
    if (!room || room.phase === 'REVEAL') return;
    room.phase = 'REVEAL';

    clearRoomTimers(room);

    const knower = room.mode === 'presence'
        ? room.players.find(p => p.id === room.lastPresencePlayerId)
        : null;

    // Im Präsenz-Modus: "richtige Antwort" ist die Formulierung des Wissenden
    const correctText = knower
        ? knower.currentAnswer
        : room.currentQuestion.answer;

    // Punkte berechnen
    room.players.forEach(p => p.roundPoints = 0);
    room.players.forEach(voter => {
        if (!voter.votedFor) return;
        if (knower && voter.id === knower.id) return; // Wissender kann nicht für sich selbst voten

        const votedCorrect = voter.votedFor === correctText;

        if (votedCorrect) {
            voter.points      += 3;
            voter.roundPoints += 3;
            voter.statsCorrect = (voter.statsCorrect || 0) + 1;
        } else {
            const liar = room.players.find(p => p.currentAnswer === voter.votedFor && p.id !== voter.id);
            if (liar && (!knower || liar.id !== knower.id)) {
                liar.points       += 2;
                liar.roundPoints  += 2;
                liar.statsBluffed  = (liar.statsBluffed || 0) + 1;
            }
            voter.statsFooled = (voter.statsFooled || 0) + 1;
        }
    });

    // Wissender: +1 pro Person die falsch votet
    if (knower) {
        const wrongVoters = room.players.filter(p =>
            p.id !== knower.id && p.votedFor && p.votedFor !== correctText
        ).length;
        knower.points      += wrongVoters;
        knower.roundPoints += wrongVoters;
    }

    io.to(roomId).emit('resultsRevealed', {
        shuffledAnswers: room.shuffledAnswers,
        players: cleanPlayers(room.players),
        correctAnswer: correctText,
        trueAnswer: room.currentQuestion.answer, // für Anzeige in der Auflösung
        knowerName: knower ? knower.name : null,
    });
}

// ── Präsenz-Modus Hilfsfunktionen ─────────────────────────────────────────────
function pickPresencePlayer(room) {
    // Zufällig, aber nicht denselben wie letzte Runde
    const eligible = room.players.filter(p => p.id !== room.lastPresencePlayerId);
    const pool = eligible.length > 0 ? eligible : room.players;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── Hilfsfunktion: saubere Player-Daten (ohne nicht-serialisierbare Objekte) ──
function cleanPlayers(players) {
    return players.map(({ voteLockTimer, ...rest }) => rest);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

    // Kategorien schicken wenn jemand connectet
    socket.emit('categoriesAvailable', availableCategories);

    // ── Raum erstellen ────────────────────────────────────────────────────────
    socket.on('createRoom', ({ playerName, customCode, maxRounds, categories, mode, writeTimer, voteTimer }) => {
        let roomId = customCode ? customCode.trim().toUpperCase() : Math.random().toString(36).substring(2, 5).toUpperCase();
        if (rooms[roomId] && !customCode) roomId += Math.floor(Math.random() * 10);

        const hostPlayer = {
            socketId: socket.id, id: socket.id, name: playerName,
            points: 0, roomId, isOffline: false,
            currentAnswer: '', votedFor: null, roundPoints: 0,
        };

        players.set(socket.id, hostPlayer);
        rooms[roomId] = {
            host: socket.id,
            players: [hostPlayer],
            phase: 'LOBBY',
            currentRound: 0,
            maxRounds: parseInt(maxRounds) || 0,
            currentQuestion: null,
            shuffledAnswers: [],
            usedQuestionIds: new Set(),
            categories: categories || [],
            mode: mode || 'digital', // 'digital' | 'presence'
            lastPresencePlayerId: null,
            writeTimer: null,
            voteTimer: null,
            writeSecs: Math.max(10, parseInt(writeTimer) || 90),
            voteSecs:  Math.max(10, parseInt(voteTimer)  || 60),
        };

        socket.join(roomId);
        socket.emit('roomCreated', {
            roomId,
            players: rooms[roomId].players,
            maxRounds: rooms[roomId].maxRounds,
            mode: rooms[roomId].mode,
            writeTimer: rooms[roomId].writeSecs,
            voteTimer:  rooms[roomId].voteSecs,
        });
    });

    // ── Raum beitreten ────────────────────────────────────────────────────────
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', 'Raum nicht gefunden');

        // Reconnect?
        const existingPlayer = Array.from(players.values()).find(p =>
            p.roomId === roomId && p.name === playerName && p.isOffline === true
        );

        if (existingPlayer) {
            const oldSocketId = existingPlayer.socketId;
            if (disconnectTimeouts[playerName + roomId]) {
                clearTimeout(disconnectTimeouts[playerName + roomId]);
                delete disconnectTimeouts[playerName + roomId];
            }
            const playerInArray = room.players.find(p => p.name === playerName);
            if (playerInArray) {
                playerInArray.id = socket.id;
                playerInArray.socketId = socket.id;
                playerInArray.isOffline = false;
            }
            players.delete(oldSocketId);
            existingPlayer.socketId = socket.id;
            existingPlayer.id = socket.id;
            existingPlayer.isOffline = false;
            players.set(socket.id, existingPlayer);

            socket.join(roomId);
            socket.emit('joinedSuccess', roomId);
            socket.emit('initRejoin', {
                points: existingPlayer.points,
                phase: room.phase,
                currentQuestion: room.currentQuestion ? room.currentQuestion.question : null,
                currentRound: room.currentRound,
                maxRounds: room.maxRounds,
                mode: room.mode,
                writeTimer: room.writeSecs,
                voteTimer:  room.voteSecs,
                alreadySubmitted: existingPlayer.currentAnswer !== '',
                shuffledAnswers: room.shuffledAnswers ? room.shuffledAnswers.map(a => a.text) : [],
                myLastAnswer: existingPlayer.currentAnswer,
            });
        } else {
            if (room.players.find(p => p.name === playerName && !p.isOffline)) {
                return socket.emit('error', 'Name bereits im Spiel!');
            }
            const newPlayer = {
                socketId: socket.id, id: socket.id, name: playerName,
                points: 0, roomId, isOffline: false,
                currentAnswer: '', votedFor: null, roundPoints: 0,
            };
            players.set(socket.id, newPlayer);
            room.players.push(newPlayer);
            socket.join(roomId);
            socket.emit('joinedSuccess', roomId);
        }
        io.to(roomId).emit('updatePlayerList', cleanPlayers(room.players));
    });

    // ── Nächste Frage / Spiel starten ─────────────────────────────────────────
    socket.on('nextQuestion', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;

        room.currentRound++;

        if (room.maxRounds > 0 && room.currentRound > room.maxRounds) {
            clearRoomTimers(room);
            io.to(roomId).emit('gameEnded', { players: cleanPlayers(room.players), stats: computeStats(room) });
            return;
        }

        // Reset
        room.revealScheduled = false;
        room.players.forEach(p => {
            p.currentAnswer  = '';
            p.votedFor       = null;
            p.roundPoints    = 0;
            p.voteLocked     = false;
            clearTimeout(p.voteLockTimer);
            p.voteLockTimer  = null;
        });

        const q = pickQuestion(room);
        room.currentQuestion = q;
        room.usedQuestionIds.add(q.question);
        room.phase = 'WRITING';

        io.to(roomId).emit('newQuestion', {
            question: q.question,
            category: q.category,
            currentRound: room.currentRound,
            maxRounds: room.maxRounds,
            mode: room.mode,
        });

        // Präsenz-Modus: einem zufälligen Spieler die richtige Antwort schicken
        if (room.mode === 'presence') {
            const chosen = pickPresencePlayer(room);
            room.lastPresencePlayerId = chosen.id;
            // Dem gewählten Spieler privat die Antwort mitteilen
            io.to(chosen.id).emit('youHaveTheAnswer', {
                answer: q.answer,
                playerName: chosen.name,
            });
            // Allen anderen sagen dass jemand die Antwort kennt
            // Host bekommt keinen Namen (spielt ja mit!)
            room.players.forEach(p => {
                if (p.id === chosen.id) return; // Wissender selbst überspringen
                if (p.id === room.host) {
                    // Host bekommt nur neutrale Info
                    io.to(p.id).emit('presencePlayerChosen', { playerName: null });
                } else {
                    io.to(p.id).emit('presencePlayerChosen', { playerName: chosen.name });
                }
            });
            // Im Präsenz-Modus kein Write-Timer
        } else {
            startWriteTimer(roomId);
        }
    });

    // ── Antwort abschicken ────────────────────────────────────────────────────
    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        if (!room || room.phase !== 'WRITING') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const trimmed = answer.trim();
        if (!trimmed) return;

        player.currentAnswer = trimmed;
        io.to(roomId).emit('playerSubmitted', socket.id);
        io.to(roomId).emit('updatePlayerList', cleanPlayers(room.players));

        // Alle abgegeben?
        const allDone = room.players.every(p => p.currentAnswer !== '');
        if (allDone) {
            clearRoomTimers(room);
            // Beide Modi: automatisch Voting starten
            // Im Präsenz-Modus erst kurz warten damit alle ihr "abgeschickt" sehen
            setTimeout(() => startVotingPhase(roomId), room.mode === 'presence' ? 1500 : 750);
        }
    });

    // ── Host startet Voting manuell (Präsenz-Modus) ───────────────────────────
    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        if (room.phase !== 'WRITING') return;
        // Im Präsenz-Modus: Spieler haben keine Antwort eingetippt -> wir bauen
        // die Optionen aus dem Array auf (jeder nennt seine Antwort mündlich,
        // Host startet das Voting damit die Leute digital abstimmen können)
        startVotingPhase(roomId);
    });

    // ── Vote abschicken ───────────────────────────────────────────────────────
    socket.on('submitVote', ({ roomId, answerText }) => {
        try {
            const room = rooms[roomId];
            if (!room || room.phase !== 'VOTING') return;
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            // Gesperrt? (nach 5s Countdown)
            if (player.voteLocked) return;

            // Umentscheidung erlaubt solange nicht gesperrt
            player.votedFor = answerText;

            // 5s-Timer starten (nur beim ersten Vote)
            if (!player.voteLockTimer) {
                player.voteLockTimer = setTimeout(() => {
                    player.voteLocked = true;
                    player.voteLockTimer = null;
                    // Jetzt prüfen ob alle fertig sind
                    if (room.phase !== 'VOTING') return;
                    const allDone = room.players.every(p => p.votedFor !== null);
                    if (allDone && !room.revealScheduled) {
                        room.revealScheduled = true;
                        clearRoomTimers(room);
                        setTimeout(() => doReveal(roomId), 2000);
                    }
                }, 5000);
            }

            io.to(roomId).emit('playerSubmitted', socket.id);
            io.to(roomId).emit('updatePlayerList', cleanPlayers(room.players));

            // Alle haben abgestimmt → direkt aufdecken
            const allVoted = room.players.every(p => p.votedFor !== null);
            if (allVoted && !room.revealScheduled) {
                room.revealScheduled = true;
                room.players.forEach(p => {
                    clearTimeout(p.voteLockTimer);
                    p.voteLockTimer = null;
                    p.voteLocked = true;
                });
                clearRoomTimers(room);
                setTimeout(() => doReveal(roomId), 2000);
            }
        } catch(e) {
            console.error('submitVote error:', e);
        }
    });

    socket.on('lockVote', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.voteLocked = true;
    });

    // ── Veto: Host bestraft Spieler (Präsenz-Modus) ─────────────────────────────
    socket.on('vetoPlayer', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        const target = room.players.find(p => p.name === playerName);
        if (!target) return;
        // Strafe: doppelte Rundengewinne abziehen (minimum 2)
        const penalty = Math.max(2, target.roundPoints * 2);
        target.points      -= penalty;
        target.roundPoints -= penalty;
        io.to(roomId).emit('vetoed', { playerName, penalty, players: cleanPlayers(room.players) });
    });

    // ── Host-Controls ─────────────────────────────────────────────────────────
    socket.on('triggerShowAuthors', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        io.to(roomId).emit('showAuthors');
    });

    socket.on('triggerHighlightCorrect', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        io.to(roomId).emit('highlightCorrectAnswer');
        // showAuthors nur im Präsenz-Modus (Digital macht's client-seitig)
        if (room.mode === 'presence') {
            setTimeout(() => io.to(roomId).emit('showAuthors'), 600);
        }
    });

    socket.on('forceEndGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        clearRoomTimers(room);
        io.to(roomId).emit('gameEnded', { players: cleanPlayers(room.players), stats: computeStats(room) });
    });

    socket.on('rematch', (roomId) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        clearRoomTimers(room);
        room.currentRound = 0;
        room.usedQuestionIds.clear();
        room.players.forEach(p => { p.points = 0; p.currentAnswer = ''; p.votedFor = null; p.roundPoints = 0; });
        io.to(roomId).emit('rematchStarted', room.players);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (!player) return;

        const { roomId, name } = player;
        const key = name + roomId;
        console.log(`${name} getrennt. Warte 5min...`);
        player.isOffline = true;
        io.to(roomId).emit('updatePlayerList', rooms[roomId]?.players || []);

        if (disconnectTimeouts[key]) clearTimeout(disconnectTimeouts[key]);
        disconnectTimeouts[key] = setTimeout(() => {
            const check = Array.from(players.values()).find(p => p.name === name && p.roomId === roomId);
            if (check && check.isOffline) {
                leaveRoom(check.socketId);
                delete disconnectTimeouts[key];
            }
        }, 300_000);
    });

    socket.on('youAreHost', () => {}); // Client-seitig behandelt

    // ── Reaktionen ────────────────────────────────────────────────────────────
    socket.on('sendReaction', ({ roomId, emoji }) => {
        const player = players.get(socket.id);
        if (!player) return;
        io.to(roomId).emit('reaction', { name: player.name, emoji });
    });

    // ── Raum freiwillig verlassen ─────────────────────────────────────────────
    socket.on('leaveRoom', () => {
        const player = players.get(socket.id);
        if (!player) return;
        const { roomId, name } = player;
        const key = name + roomId;
        if (disconnectTimeouts[key]) { clearTimeout(disconnectTimeouts[key]); delete disconnectTimeouts[key]; }
        leaveRoom(socket.id);
        socket.leave(roomId);
        socket.emit('leftRoom');
    });
});

// ── Statistiken berechnen ────────────────────────────────────────────────────
function computeStats(room) {
    const players = room.players;
    if (!players.length) return [];

    const stats = [];

    // Bester Bluffer: meiste statsBluffed
    const bluffer = [...players].sort((a,b) => (b.statsBluffed||0) - (a.statsBluffed||0))[0];
    if ((bluffer.statsBluffed||0) > 0)
        stats.push({ emoji: '🎭', title: 'Bester Bluffer', name: bluffer.name, value: `${bluffer.statsBluffed}x jemanden getäuscht` });

    // Detektiv: meiste statsCorrect
    const detective = [...players].sort((a,b) => (b.statsCorrect||0) - (a.statsCorrect||0))[0];
    if ((detective.statsCorrect||0) > 0)
        stats.push({ emoji: '🔍', title: 'Meisterhafter Detektiv', name: detective.name, value: `${detective.statsCorrect}x die Wahrheit erkannt` });

    // Leichtgläubigster: meiste statsFooled
    const fooled = [...players].sort((a,b) => (b.statsFooled||0) - (a.statsFooled||0))[0];
    if ((fooled.statsFooled||0) > 0)
        stats.push({ emoji: '🤡', title: 'Leichtgläubigster', name: fooled.name, value: `${fooled.statsFooled}x auf eine Lüge reingefallen` });

    return stats;
}

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled Rejection:', reason);
});

server.listen(PORT, () => console.log(`🎮 BluffIt läuft auf Port ${PORT}`));
