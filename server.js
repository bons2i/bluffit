const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const disconnectTimeouts = {};

app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let rooms = {}; // Hier speichern wir alle aktiven Räume
let questions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
let players = new Map(); 


// Hilfsfunktion zum Mischen von Arrays (Fisher-Yates Shuffle)
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Hilfsfunktion: Gibt alle Spieler eines Raums zurück
function getPlayersInRoom(roomId) {
    return Array.from(players.values()).filter(p => p.roomId === roomId);
}

// Hilfsfunktion: Spieler sauber entfernen
function leaveRoom(socketId) {
    const player = players.get(socketId);
    if (!player) return;

    const roomId = player.roomId;
    const room = rooms[roomId];

    if (room) {
        // Spieler aus dem Raum-Array löschen
        room.players = room.players.filter(p => p.id !== socketId);
        // Spieler aus der globalen Map löschen
        players.delete(socketId);

        // Wenn der Raum jetzt leer ist -> Raum löschen
        if (room.players.length === 0) {
            delete rooms[roomId];
        } else {
            // Wenn der Host gegangen ist -> Neuen Host ernennen
            if (room.host === socketId) {
                room.host = room.players[0].id;
                io.to(room.host).emit('youAreHost');
            }
            // Liste für alle anderen aktualisieren
            io.to(roomId).emit('updatePlayerList', room.players);
        }
    }
}



io.on('connection', (socket) => {
    // Raum erstellen
    socket.on('createRoom', ({ playerName, customCode, maxRounds }) => {
        let roomId = customCode ? customCode.trim().toUpperCase() : Math.random().toString(36).substring(2, 5).toUpperCase();
        if (rooms[roomId] && !customCode) roomId += Math.floor(Math.random() * 10);

        // 1. Das Spieler-Objekt EINMAL definieren
        const hostPlayer = { 
            socketId: socket.id, 
            id: socket.id, 
            name: playerName, 
            points: 0, 
            roomId: roomId, 
            isOffline: false,
            currentAnswer: '',
            votedFor: null,
            roundPoints: 0
        };

        // 2. In die globale Map UND in den neuen Raum setzen
        players.set(socket.id, hostPlayer); 
        
        rooms[roomId] = {
            host: socket.id,
            players: [hostPlayer], // Hier wird jetzt die Referenz auf hostPlayer genutzt
            phase: 'LOBBY',
            currentRound: 0,
            maxRounds: parseInt(maxRounds) || 0,
            currentQuestion: null,
            shuffledAnswers: []
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players, maxRounds: rooms[roomId].maxRounds });
    });

    // Raum beitreten
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', 'Raum nicht gefunden');

        const existingPlayer = Array.from(players.values()).find(p => 
            p.roomId === roomId && p.name === playerName && p.isOffline === true
        );

        if (existingPlayer) {
            const oldSocketId = existingPlayer.socketId; 
            if (disconnectTimeouts[playerName]) {
                clearTimeout(disconnectTimeouts[playerName]);
                delete disconnectTimeouts[playerName];
            }

            // --- DUBLETTEN-STOPPER ---
            // Wir aktualisieren die ID direkt im Array
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
                alreadySubmitted: existingPlayer.currentAnswer !== '',
                shuffledAnswers: room.shuffledAnswers ? room.shuffledAnswers.map(a => a.text) : [],
                myLastAnswer: existingPlayer.currentAnswer 
            });
        } else {
            // Normaler Join: Verhindern, dass jemand mit gleichem Namen joint, wenn Spieler online ist
            if (room.players.find(p => p.name === playerName) && existingPlayer.isOffline = false) {
                return socket.emit('error', 'Name bereits im Spiel!');
            }

            const newPlayer = { 
                socketId: socket.id, id: socket.id, name: playerName, 
                points: 0, roomId: roomId, isOffline: false,
                currentAnswer: '', votedFor: null, roundPoints: 0 
            };
            players.set(socket.id, newPlayer);
            room.players.push(newPlayer);
            socket.join(roomId);
            socket.emit('joinedSuccess', roomId);
        }
        io.to(roomId).emit('updatePlayerList', room.players);
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

        // Wir suchen den Spieler im RAUM-Array anhand seines Namens oder der aktuellen Socket-ID
        // Das ist sicherer bei Reconnects!
        const player = room.players.find(p => p.id === socket.id);
        
        if (player) {
            player.currentAnswer = answer;
            console.log(`✅ Antwort von ${player.name} empfangen.`);
            
            io.to(roomId).emit('playerSubmitted', socket.id);

            // WICHTIG: Wir prüfen nur Spieler, die NICHT offline sind ODER wir prüfen alle,
            // aber wir stellen sicher, dass wir die Leichen im Array ignorieren.
            const waitingFor = room.players.filter(p => p.currentAnswer === '');

            if (waitingFor.length === 0) {
                console.log("🚀 Alle Antworten da! Starte Voting...");
                room.phase = 'VOTING';
                
                let allAns = [{ text: room.currentQuestion.answer, isCorrect: true, creator: 'SERVER' }];
                room.players.forEach(p => {
                    if (p.currentAnswer) {
                        allAns.push({ text: p.currentAnswer, isCorrect: false, creator: p.id });
                    }
                });
                
                room.shuffledAnswers = shuffle(allAns);
                io.to(roomId).emit('showVotingOptions', room.shuffledAnswers.map(a => a.text));
            } else {
                console.log(`⏳ Warte noch auf: ${waitingFor.map(p => p.name).join(', ')}`);
            }
        } else {
            console.log("❌ Fehler: Ein Socket hat versucht zu antworten, der nicht im Raum-Array ist.");
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

            setTimeout(() => {
                io.to(roomId).emit('showAuthors');
            }, 500);
        }
    });

    // NEU: Host will die Autoren aufdecken
    //socket.on('triggerShowAuthors', (roomId) => {
    //    const room = rooms[roomId];
    //    if (socket.id === room.host) {
    //        io.to(roomId).emit('showAuthors');
    //    }
    //});

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
        const player = players.get(socket.id);
        if (player) {
            const roomId = player.roomId;
            const playerName = player.name;
            
            console.log(`${playerName} hat die Verbindung verloren. Warte 60s...`);
            player.isOffline = true;

            // Falls es schon einen Timer für diesen Namen gibt (sollte nicht sein, aber sicher ist sicher), löschen
            if (disconnectTimeouts[playerName]) clearTimeout(disconnectTimeouts[playerName]);

            // Timer starten
            disconnectTimeouts[playerName] = setTimeout(() => {
                // Prüfen, ob der Spieler immer noch offline ist
                const checkPlayer = Array.from(players.values()).find(p => p.name === playerName && p.roomId === roomId);
                
                if (checkPlayer && checkPlayer.isOffline) {
                    console.log(`${playerName} ist nach 60s nicht zurückgekehrt. Lösche Spieler.`);
                    leaveRoom(checkPlayer.socketId); // Deine Funktion zum Entfernen aus dem Spiel
                    delete disconnectTimeouts[playerName];
                }
            }, 300000); // 5minuten (300 Sekunden) Gnadenfrist
        }
    });

}); // Ende connection
    

server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);

});

