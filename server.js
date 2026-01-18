const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let rooms = {}; // Hier speichern wir alle aktiven Räume
let questions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));

// Hilfsfunktion zum Mischen von Arrays (Fisher-Yates Shuffle)
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

io.on('connection', (socket) => {
    // Raum erstellen
    socket.on('createRoom', ({ playerName, customCode, maxRounds }) => {
    let roomId;

    // Prüfen: Wurde ein Code eingegeben UND ist dieser noch nicht vergeben?
    if (customCode && customCode.trim().length > 0) {
        if (!rooms[customCode]) {
            roomId = customCode.trim().toUpperCase();
        } else {
            // Falls der Code schon existiert, hängen wir eine Zufallszahl an
            roomId = customCode.trim().toUpperCase() + Math.floor(Math.random() * 10);
        }
    } else {
        // Kein Wunsch-Code -> komplett zufällig
        roomId = Math.random().toString(36).substring(2, 5).toUpperCase();
    }
    
    rooms[roomId] = {
        host: socket.id,
        players: [{ id: socket.id, name: playerName, points: 0, currentAnswer: '', votedFor: null, roundPoints: 0 }],
        phase: 'LOBBY',
        currentRound: 0,
        maxRounds: parseInt(maxRounds) || 0,
        currentQuestion: null,
        shuffledAnswers: []
    };

    socket.join(roomId);
    // WICHTIG: Hier schicken wir die finale roomId zurück an den Host
    socket.emit('roomCreated', { roomId, players: rooms[roomId].players, maxRounds: rooms[roomId].maxRounds });
});

    // Raum beitreten
    socket.on('joinRoom', ({ roomId, playerName }) => {
        if (rooms[roomId]) {
            rooms[roomId].players.push({ id: socket.id, name: playerName, points: 0, currentAnswer: '', votedFor: null });
            socket.join(roomId);
            io.to(roomId).emit('updatePlayerList', rooms[roomId].players);
            socket.emit('joinedSuccess', roomId);
        } else {
            socket.emit('error', 'Raum nicht gefunden');
        }
    });

   // Spiel starten / Neue Frage (nur Host)
    socket.on('nextQuestion', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        room.currentRound++;
        
        // Prüfen ob Ende erreicht
        if (room.maxRounds > 0 && room.currentRound > room.maxRounds) {
            io.to(roomId).emit('gameEnded', room.players);
        } else {
            // --- WICHTIG: Vorherige Antworten der Spieler löschen! ---
            room.players.forEach(p => {
                p.currentAnswer = '';
                p.votedFor = null;
                p.roundPoints = 0;
            });

            // --- WICHTIG: Eine zufällige Frage auswählen ---
            const randomIndex = Math.floor(Math.random() * questions.length);
            const randomQ = questions[randomIndex]; // Hier lag der Fehler (randomQ war nicht definiert)
            room.currentQuestion = randomQ;
            room.phase = 'WRITING';

            io.to(roomId).emit('newQuestion', { 
                question: randomQ.question, 
                currentRound: room.currentRound, 
                maxRounds: room.maxRounds 
            });
        }
    });

    // Manuelles Beenden durch Host
    socket.on('forceEndGame', (roomId) => {
        const room = rooms[roomId];
        if (socket.id === room.host) {
            io.to(roomId).emit('gameEnded', room.players);
        }
    });

    // Antwort eines Spielers empfangen
    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.currentAnswer = answer;
            io.to(roomId).emit('playerSubmitted', socket.id);

            const allFinished = room.players.every(p => p.currentAnswer && p.currentAnswer.length > 0);

            if (allFinished) {
                // --- AUTOMATISIERUNG ---
                // Statt nur dem Host Bescheid zu geben, starten wir direkt das Voting:
                startVotingLogic(roomId); 
            }
        }
    });

    function startVotingLogic(roomId) {
        const room = rooms[roomId];
        room.phase = 'VOTING';
        
        let allAnswers = [{ text: room.currentQuestion.answer, isCorrect: true, creator: 'SERVER' }];
        room.players.forEach(p => {
            if(p.currentAnswer) {
                allAnswers.push({ text: p.currentAnswer, isCorrect: false, creator: p.id });
            }
        });

        room.shuffledAnswers = shuffle(allAnswers);
        io.to(roomId).emit('showVotingOptions', room.shuffledAnswers.map(a => a.text));
    }


    // Spieler gibt seine Stimme ab
    socket.on('submitVote', ({ roomId, answerText }) => {
        const room = rooms[roomId];
        if (!room) return; // Sicherheitsscheck hinzugefügt
        const player = room.players.find(p => p.id === socket.id);

        if (player && room.phase === 'VOTING') {
            player.votedFor = answerText;

            // 1. Allen zeigen, dass dieser Spieler gewählt hat
            io.to(roomId).emit('playerSubmitted', socket.id);

            // 2. Prüfen, ob ALLE Spieler gewählt haben
            const allVoted = room.players.every(p => p.votedFor !== null);

            if (allVoted) {
                // HIER WAR DER FEHLER: Komma vor der 2000 hinzugefügt
                setTimeout(() => {
                    room.phase = 'REVEAL'; 

                    // Punkteberechnung direkt hier durchführen, damit die Daten aktuell sind
                    // Schritt A: Alle Rundenpunkte auf 0 setzen
                    room.players.forEach(p => p.roundPoints = 0);

                    // Schritt B: Punkte verteilen
                    room.players.forEach(voter => {
                        if (!voter.votedFor) return;
                        if (voter.votedFor === room.currentQuestion.answer) {
                            voter.points += 3;
                            voter.roundPoints += 3;
                        } else {
                            const liar = room.players.find(p => p.currentAnswer === voter.votedFor);
                            if (liar && liar.id !== voter.id) {
                                liar.points += 2;
                                liar.roundPoints += 2;
                            }
                        }
                    });

                    io.to(roomId).emit('resultsRevealed', {
                        shuffledAnswers: room.shuffledAnswers,
                        players: room.players,
                        correctAnswer: room.currentQuestion.answer
                    });
                }, 1000); 
            }
        }
    });

    socket.on('revealResults', (roomId) => {
        const room = rooms[roomId];
        if (socket.id !== room.host) return;

        room.phase = 'REVEAL';

        // Punkteberechnung
        room.players.forEach(player => {
            let earnedPoints = 0; // Punkte nur für diese Runde

            // Nur berechnen, wenn der Spieler überhaupt gevotet hat
            if (player.votedFor) {
                // 1. Hat der Spieler die richtige Antwort gewählt?
                if (player.votedFor === room.currentQuestion.answer) {
                    earnedPoints += 3;
                } else {
                    // 2. Er hat eine Lüge gewählt. Wer war der Urheber?
                    // WICHTIG: Urheber finden, aber nicht sich selbst Punkte geben
                    const liar = room.players.find(p => p.currentAnswer === player.votedFor);
                    if (liar && liar.id !== player.id) {
                        // Der Lügner bekommt Punkte (wird beim Lügner-Loop draufgerechnet)
                        // Wir müssen das hier beim Lügner direkt addieren:
                        liar.points += 2;
                        
                        // Wir müssen dem Lügner auch bescheid sagen, dass er Punkte bekommen hat
                        // Da wir aber gerade über den "Voter" iterieren, ist das tricky.
                        // BESSERER WEG UNTEN:
                    }
                }
            }
        });

        // SAUBERE BERECHNUNG NEU AUFSETZEN (um Fehler zu vermeiden):
        // Schritt A: Alle Rundenpunkte auf 0 setzen
        room.players.forEach(p => p.roundPoints = 0);

        // Schritt B: Punkte verteilen
        room.players.forEach(voter => {
            if (!voter.votedFor) return;

            // Fall 1: Voter hat Richtig getippt
            if (voter.votedFor === room.currentQuestion.answer) {
                voter.points += 3;
                voter.roundPoints += 3;
            } 
            // Fall 2: Voter hat Lüge getippt
            else {
                const liar = room.players.find(p => p.currentAnswer === voter.votedFor);
                if (liar && liar.id !== voter.id) {
                    liar.points += 2;
                    liar.roundPoints += 2;
                }
            }
        });

        // Daten senden (jetzt inklusive roundPoints im player objekt)
        io.to(roomId).emit('resultsRevealed', {
            players: room.players,
            correctAnswer: room.currentQuestion.answer,
            shuffledAnswers: room.shuffledAnswers
        });
    });

    socket.on('triggerRevealStep2', (roomId) => {
        const room = rooms[roomId];
        if (socket.id === room.host) {
            // Sag ALLEN Clients im Raum: "Zeigt jetzt die Lösung!"
            io.to(roomId).emit('showFinalResult');
        }
    });

    socket.on('triggerHighlightCorrect', (roomId) => {
        const room = rooms[roomId];
        if (socket.id === room.host) {
            io.to(roomId).emit('highlightCorrectAnswer');
        }
    });

    // NEU: Host will die Autoren aufdecken
    socket.on('triggerShowAuthors', (roomId) => {
        const room = rooms[roomId];
        if (socket.id === room.host) {
            io.to(roomId).emit('showAuthors');
        }
    });

    socket.on('rematch', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        // Nur der Host darf das Rematch starten
        if (socket.id !== room.host) return;

        // 1. Alle Punkte und Status-Werte zurücksetzen
        room.currentRound = 0;
        room.players.forEach(p => {
            p.points = 0;
            p.currentAnswer = '';
            p.votedFor = null;
            p.roundPoints = 0;
        });

        // 2. Allen im Raum sagen, dass es von vorne losgeht (zurück in die Lobby)
        io.to(roomId).emit('rematchStarted', room.players);
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const isHost = (socket.id === room.host);
                room.players.splice(playerIndex, 1); // Spieler entfernen

                if (room.players.length === 0) {
                    delete rooms[roomId]; // Raum löschen, wenn leer
                } else if (isHost) {
                    // Neuer Host ist der erste verbleibende Spieler
                    room.host = room.players[0].id;
                    // Alle informieren, wer der neue Host ist
                    io.to(roomId).emit('updatePlayerList', room.players);
                    io.to(room.host).emit('youAreHost'); 
                } else {
                    io.to(roomId).emit('updatePlayerList', room.players);
                }
            }
        }
    });

}); // Ende connection
    

server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);

});
