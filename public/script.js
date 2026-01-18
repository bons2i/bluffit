const socket = io();

// Status Variablen
let myRoomId = null;
let amIHost = false;
let myLastAnswer = ""; 
let currentRevealData = null;
let currentRound = 0;
let maxRounds = 0;
let showTicks = false;

// --- DOM Elemente referenzieren ---
const landingSection = document.getElementById('landing-section');
const gameRoomSection = document.getElementById('game-room-section');
const gameHeader = document.getElementById('game-header');
const joinDialog = document.getElementById('join-dialog');

const phaseLobby = document.getElementById('phase-lobby');
const phaseWriting = document.getElementById('phase-writing');
const phaseVoting = document.getElementById('phase-voting');
const phaseReveal = document.getElementById('phase-reveal');
const phaseEndResults = document.getElementById('phase-end-results');

const roomCodeDisplay = document.getElementById('room-code-display');
const playerList = document.getElementById('player-list');
const questionText = document.getElementById('question-text');
const myAnswerInput = document.getElementById('my-answer-input');
const waitingMessage = document.getElementById('waiting-message');

const correctAnswerDisplay = document.getElementById('correct-answer-display');
const votingOptions = document.getElementById('voting-options');
const votingDistribution = document.getElementById('voting-distribution');
const finalPointsList = document.getElementById('final-points-list');

const roundSummary = document.getElementById('round-summary');
const roundPointsGrid = document.getElementById('round-points-grid');

const createDialog = document.getElementById('create-dialog');
const createNameInput = document.getElementById('create-name-input');
const createCodeInput = document.getElementById('create-code-input');
const btnCreateConfirm = document.getElementById('btn-create-confirm');
const btnCreateCancel = document.getElementById('btn-create-cancel');

const createRoundsInput = document.getElementById('create-rounds-input');
const roundCounter = document.getElementById('round-counter');
const podiumList = document.getElementById('podium-list');

// Host Controls & Buttons
const hostControls = document.getElementById('host-controls');
const btnStartGame = document.getElementById('btn-start-game');
const btnShowResults = document.getElementById('btn-show-results');
const btnRevealAnswer = document.getElementById('btn-reveal-answer');
const btnStartNextRound = document.getElementById('btn-start-next-round');
const btnRevealAuthors = document.getElementById('btn-reveal-authors');

// Sonstige Buttons
const btnCreateRoom = document.getElementById('btn-create-room');
const btnShowJoin = document.getElementById('btn-show-join');
const btnJoinConfirm = document.getElementById('btn-join-confirm');
const btnJoinCancel = document.getElementById('btn-join-cancel');
const btnSubmitAnswer = document.getElementById('btn-submit-answer');

const revealStep1 = document.getElementById('reveal-step-1');
const revealStep2 = document.getElementById('reveal-step-2');

// --- HILFSFUNKTIONEN ---

function showSection(sectionId) {
    landingSection.classList.add('hidden');
    gameRoomSection.classList.add('hidden');
    joinDialog.classList.add('hidden');
    document.getElementById(sectionId).classList.remove('hidden');
    if(sectionId === 'game-room-section') gameHeader.classList.remove('hidden');
}

function showGamePhase(phaseId) {
    phaseLobby.classList.add('hidden');
    phaseWriting.classList.add('hidden');
    phaseVoting.classList.add('hidden');
    phaseReveal.classList.add('hidden');
    
    // Hier wird auf die Variable zugegriffen, die wir gerade oben erstellt haben
    if (phaseEndResults) phaseEndResults.classList.add('hidden'); 
    
    const target = document.getElementById(phaseId);
    if (target) target.classList.remove('hidden');
}

function updatePlayerListUI(players) {
    if (!players || !Array.isArray(players)) return; // Verhindert Absturz bei leeren Daten
    
    playerList.innerHTML = '';

    const isWritingPhase = !phaseWriting.classList.contains('hidden');
    const isVotingPhase = !phaseVoting.classList.contains('hidden');
    
    players.forEach(p => {
        const li = document.createElement('li');
        li.setAttribute('data-id', p.id);
        const hostIndicator = (p.id === players[0].id) ? '⭐ ' : ''; 
        
        let tick = '';
        if (isWritingPhase && p.currentAnswer) {
            // In der Schreibphase: Zeige Haken, wenn Antwort da ist
            tick = '✔';
        } else if (isVotingPhase && p.votedFor) {
            // In der Votingphase: Zeige Haken, wenn p.votedFor existiert
            // (Hinweis: Dein Server muss p.votedFor in der Player-Liste mitschicken!)
            tick = '✔';
        }

        li.innerHTML = `${hostIndicator}${p.name} <span>Points: ${p.points || 0} <span class="tick-mark">${tick}</span></span>`;
        playerList.appendChild(li);
    });

    // Host-Beenden-Button
    if (amIHost) {
        const endBtn = document.createElement('button');
        endBtn.innerText = "Spiel beenden";
        endBtn.className = "btn neon-btn-plain";
        endBtn.style.width = "100%";
        endBtn.style.marginTop = "10px";
        endBtn.style.fontSize = "0.7rem";
        endBtn.style.background = "transparent";
        endBtn.style.color = "rgba(255, 255, 255, 0.5)";
        endBtn.onclick = () => {
            if(confirm("Spiel wirklich für alle beenden?")) socket.emit('forceEndGame', myRoomId);
        };
        playerList.appendChild(endBtn);
    }
}



// --- EVENT LISTENERS ---

// 1. Create Dialog anzeigen
btnCreateRoom.addEventListener('click', () => {
    joinDialog.classList.add('hidden'); // Falls der andere offen ist
    createDialog.classList.remove('hidden');
});

// 2. Abbrechen
btnCreateCancel.addEventListener('click', () => {
    createDialog.classList.add('hidden');
});

// 3. Bestätigen & Erstellen
btnCreateConfirm.addEventListener('click', () => {
    const name = createNameInput.value.trim();
    const code = createCodeInput.value.trim(); // Das ist dein Wunsch-Code Feld
    const rounds = createRoundsInput.value;

    if (name) {
        socket.emit('createRoom', { 
            playerName: name, 
            customCode: code, 
            maxRounds: rounds 
        });
    } else {
        alert("Bitte gib einen Namen ein!");
    }
});

// In der showSection Funktion musst du den neuen Dialog auch verstecken:
function showSection(sectionId) {
    landingSection.classList.add('hidden');
    gameRoomSection.classList.add('hidden');
    joinDialog.classList.add('hidden');
    createDialog.classList.add('hidden'); // NEU
    
    document.getElementById(sectionId).classList.remove('hidden');
    if(sectionId === 'game-room-section') gameHeader.classList.remove('hidden');
}

btnShowJoin.addEventListener('click', () => joinDialog.classList.remove('hidden'));
btnJoinCancel.addEventListener('click', () => joinDialog.classList.add('hidden'));

btnJoinConfirm.addEventListener('click', () => {
    const name = document.getElementById('join-name-input').value;
    const code = document.getElementById('join-code-input').value.toUpperCase();
    if(name && code) socket.emit('joinRoom', { roomId: code, playerName: name });
});

btnStartGame.addEventListener('click', () => {
    if(amIHost) socket.emit('nextQuestion', myRoomId);
});

btnSubmitAnswer.addEventListener('click', () => {
    const answer = myAnswerInput.value.trim();
    if(answer && myRoomId) {
        myLastAnswer = answer;
        socket.emit('submitAnswer', { roomId: myRoomId, answer: answer });

        myAnswerInput.classList.add('hidden'); // Versteckt das Textfeld
        btnSubmitAnswer.classList.add('hidden'); // Versteckt den Button
        
        waitingMessage.classList.remove('hidden'); // Zeigt die Warte-Nachricht
    }
});



btnRevealAnswer.addEventListener('click', () => {
    socket.emit('triggerHighlightCorrect', myRoomId);
    btnRevealAnswer.classList.add('hidden');
    // Jetzt darf man Autoren aufdecken
    btnRevealAuthors.classList.remove('hidden');
});

// 3. Autoren aufdecken 
btnRevealAuthors.addEventListener('click', () => {
    socket.emit('triggerShowAuthors', myRoomId);
    btnRevealAuthors.classList.add('hidden');
    // Jetzt darf man nächste Runde starten
    btnStartNextRound.classList.remove('hidden');
});


document.getElementById('btn-rematch').onclick = () => {
    if (amIHost) {
        socket.emit('rematch', myRoomId);
    } else {
        alert("Nur der Host kann ein Rematch starten.");
    }
};



// --- SOCKET LISTENERS ---

socket.on('roomCreated', ({ roomId, players, maxRounds: serverMaxRounds }) => {
    myRoomId = roomId;
    amIHost = true;
    maxRounds = serverMaxRounds; // Speichern!
    roomCodeDisplay.innerText = roomId;
    hostControls.classList.remove('hidden');
    btnStartGame.classList.remove('hidden');
    updatePlayerListUI(players);
    showSection('game-room-section');
    showGamePhase('phase-lobby');
});

socket.on('joinedSuccess', (roomId) => {
    myRoomId = roomId;
    amIHost = false;
    roomCodeDisplay.innerText = roomId;
    hostControls.classList.add('hidden');
    showSection('game-room-section');
    showGamePhase('phase-lobby');
});

socket.on('updatePlayerList', (players) => updatePlayerListUI(players));

socket.on('newQuestion', (data) => {
    showTicks = true;
    questionText.innerText = data.question;
    currentRound = data.currentRound;
    maxRounds = data.maxRounds;
    

    // UI Reset
    myAnswerInput.value = '';
    myAnswerInput.disabled = false;
    myAnswerInput.classList.remove('hidden'); 
    btnSubmitAnswer.classList.remove('hidden'); 
    waitingMessage.classList.add('hidden');
    

    // Rundenzähler Text
    const roundText = maxRounds > 0 ? `Runde: ${currentRound} / ${maxRounds}` : `Runde: ${currentRound}`;
    roundCounter.innerText = roundText;
    
    updatePlayerListUI(data.players);
    showGamePhase('phase-writing');
});

socket.on('showVotingOptions', (answers) => {
    showGamePhase('phase-voting');
    showTicks = false;
    
    // WICHTIG: Die Variable muss hier oben definiert werden
    const votingOptionsContainer = document.getElementById('voting-options');
    votingOptionsContainer.innerHTML = ''; 
    
    let selectedAnswer = null;

    // 1. Antwort-Buttons erstellen
    answers.forEach(answer => {
        if (answer === myLastAnswer) return;

        const btn = document.createElement('button');
        btn.className = 'btn neon-btn-blue answer-option-btn';
        btn.innerText = answer;
        btn.style.width = "100%";
        btn.style.marginBottom = "10px";
        
        btn.onclick = () => {
            document.querySelectorAll('.answer-option-btn').forEach(b => {
                b.classList.remove('neon-btn-green');
                b.classList.add('neon-btn-blue');
            });
            btn.classList.remove('neon-btn-blue');
            btn.classList.add('neon-btn-green');
            
            selectedAnswer = answer;
            confirmBtn.classList.remove('hidden');
        };
        votingOptionsContainer.appendChild(btn);
    });

    // 2. Bestätigungs-Button erstellen
    const confirmBtn = document.createElement('button');
    confirmBtn.innerText = "🔒 Auswahl bestätigen";
    confirmBtn.className = "btn neon-btn-pink hidden";
    confirmBtn.style.marginTop = "20px";
    confirmBtn.style.width = "100%";

    // HIER IST DER FIX: Die Logik greift jetzt sicher auf den Container zu
    confirmBtn.onclick = () => {
        if (selectedAnswer) {
            // Nachricht an Server
            socket.emit('submitVote', { roomId: myRoomId, answerText: selectedAnswer });
            
            // UI Update
            votingOptionsContainer.innerHTML = ''; // Jetzt ist die Variable bekannt!

            const lockedBtn = document.createElement('button');
            lockedBtn.className = 'btn neon-btn-green';
            lockedBtn.innerText = selectedAnswer;
            lockedBtn.style.width = "100%";
            lockedBtn.disabled = true;
            lockedBtn.style.cursor = "default";
            
            const statusMsg = document.createElement('div');
            statusMsg.style.textAlign = "center";
            statusMsg.style.marginTop = "25px";
            statusMsg.innerHTML = `
                <p style="font-size: 1.2rem; margin-bottom: 5px;">✔ Auswahl eingeloggt</p>
                <p style="font-size: 0.9rem; opacity: 0.8;">Warte auf restliche Stimmen...</p>
            `;

            votingOptionsContainer.appendChild(lockedBtn);
            votingOptionsContainer.appendChild(statusMsg);
        }
    };
    
    votingOptionsContainer.appendChild(confirmBtn);
});


socket.on('playerSubmitted', (playerId) => {
    const el = document.querySelector(`li[data-id="${playerId}"] .tick-mark`);
    if(el) el.innerText = '✔';
});



// SCHRITT A: Liste bauen (Wer hat was gewählt?)
socket.on('resultsRevealed', (data) => {
    showGamePhase('phase-reveal');
    document.querySelectorAll('.tick-mark').forEach(el => el.innerText = '');
    showTicks = false;
    roundSummary.classList.add('hidden');
    currentRevealData = data; 

    const revealQuestionHeader = document.getElementById('question-text-reveal');
    questionText.innerText = data.question;
    
    
    
    // Alte Buttons resetten falls nötig
    if(amIHost) {
        btnRevealAnswer.classList.remove('hidden');
        btnRevealAuthors.classList.add('hidden'); // Erst später sichtbar
        btnStartNextRound.classList.add('hidden');
    }

    votingDistribution.innerHTML = '';

    data.shuffledAnswers.forEach((ans, index) => {
        const div = document.createElement('div');
        div.className = 'neon-border-blue answer-reveal-card'; // Klasse für Styling
        div.style.padding = '15px';
        div.style.margin = '10px 0';
        div.style.background = 'var(--bg-card)';
        
        // WICHTIG: Wir speichern Infos im HTML Element, um sie später zu finden
        div.dataset.answerText = ans.text; 
        div.dataset.creatorId = ans.creator; // Wer hat's geschrieben?

        // Wer hat gewählt?
        const voters = data.players.filter(p => p.votedFor === ans.text);
        const voterNames = voters.map(v => v.name).join(', ');

        div.innerHTML = `
            <div style="font-size: 1.2rem; font-weight: bold;">${ans.text}</div>
            <div style="color: var(--text-light); opacity: 0.8; margin-top: 5px;">
                ${voterNames ? 'Gewählt von: ' + voterNames : 'Keine Stimmen'}
            </div>
            <div class="author-placeholder"></div>
        `;
        votingDistribution.appendChild(div);
    });
    updatePlayerListUI(data.players);
});

// SCHRITT B: Richtige Antwort grün machen & Punkte updaten
socket.on('highlightCorrectAnswer', () => {
    const allCards = document.querySelectorAll('.answer-reveal-card');
    
    allCards.forEach(card => {
        // Prüfen, ob das die richtige Antwort ist
        if (card.dataset.answerText === currentRevealData.correctAnswer) {
            card.classList.remove('neon-border-blue');
            card.classList.add('reveal-correct'); // Die neue CSS Klasse!
            
            // Optional: Text "RICHTIG" hinzufügen
            const info = document.createElement('div');
            info.style.color = 'var(--neon-green)';
            info.style.fontWeight = 'bold';
            info.innerText = "★ RICHTIGE ANTWORT ★";
            card.prepend(info);
        }
    });

    // JETZT erst Punkte in der Sidebar updaten (Spannung!)
    updatePlayerListUI(currentRevealData.players);
});

// SCHRITT C: Autoren und Puntke einblenden
socket.on('showAuthors', () => {
    const allCards = document.querySelectorAll('.answer-reveal-card');

   allCards.forEach(card => {
        const creatorId = card.dataset.creatorId;
        const placeholder = card.querySelector('.author-placeholder');
        
        if (creatorId === 'SERVER') {
            // Spezialfall: Die Wahrheit leer lassen
            placeholder.innerHTML = "";
        } else {
            // Normalfall: Lüge eines Spielers
            const pName = currentRevealData.players.find(p => p.id === creatorId)?.name || "Unbekannt";
            placeholder.innerHTML = `<span class="author-info">✍️ Von: ${pName}</span>`;
        }
    });

    const roundSummary = document.getElementById('round-summary');
    const roundPointsContainer = document.getElementById('round-points-grid');
    roundSummary.classList.remove('hidden');
    roundPointsContainer.style.display = 'block'; 
    roundPointsContainer.innerHTML = '';

    currentRevealData.players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'simple-point-row'; 
        const scoreColor = p.roundPoints > 0 ? 'var(--neon-green)' : '#888';
        row.innerHTML = `<span style="color: #fff; font-weight: 500;">${p.name}:</span>
                         <span style="color: ${scoreColor}; font-weight: bold;">${p.roundPoints > 0 ? '+' : ''}${p.roundPoints}</span>`;
        roundPointsContainer.appendChild(row);
    });

    // --- HIER IST DIE KORREKTE BUTTON-LOGIK ---
    if (amIHost) {
        btnStartNextRound.classList.remove('hidden');

        if (maxRounds > 0 && currentRound >= maxRounds) {
            btnStartNextRound.innerText = "🏆 Zur Siegerehrung";
            btnStartNextRound.style.background = "var(--neon-pink)"; 
            btnStartNextRound.style.boxShadow = "0 0 15px var(--neon-pink)";
            btnStartNextRound.onclick = () => {
                socket.emit('forceEndGame', myRoomId);
            };
        } else {
            btnStartNextRound.innerText = "Nächste Runde starten";
            btnStartNextRound.style.background = ""; // Reset auf Standard
            btnStartNextRound.style.boxShadow = "";
            btnStartNextRound.onclick = () => {
                btnStartNextRound.classList.add('hidden');
                socket.emit('nextQuestion', myRoomId);
            };
        }
    }
});

socket.on('showFinalResult', () => {
    // 1. Von Schritt 1 ("Wer hat was gewählt") zu Schritt 2 ("Lösung") wechseln
    revealStep1.classList.add('hidden');
    revealStep2.classList.remove('hidden');

    // 2. Richtige Antwort anzeigen (Daten kommen aus dem Speicher currentRevealData)
    correctAnswerDisplay.innerText = currentRevealData.correctAnswer;
    
    // 3. PUNKTE UPDATEN 
    updatePlayerListUI(currentRevealData.players);
    

    // 4. Die Zusammenfassung ("Punktestand aktuell") füllen
    finalPointsList.innerHTML = '';
    currentRevealData.players.forEach(p => {
        const li = document.createElement('li');
        li.innerText = `${p.name}: ${p.points} Punkte`;
        finalPointsList.appendChild(li);
    });

    // 5. Nur der Host bekommt den Button für die nächste Runde
    if (amIHost) {
    btnStartNextRound.classList.remove('hidden');

    // Prüfen: Sind wir in der allerletzten Runde?
    if (maxRounds > 0 && currentRound >= maxRounds) {
        // Wir sind am Ende!
        btnStartNextRound.innerText = "🏆 Zur Siegerehrung";
        btnStartNextRound.style.background = "var(--neon-pink)"; 
        btnStartNextRound.style.boxShadow = "0 0 15px var(--neon-pink)";
        
        // Wir ändern die Funktion des Buttons: Er soll nicht mehr "nextQuestion" 
        // senden, sondern direkt das Ende triggern
        btnStartNextRound.onclick = () => {
            socket.emit('forceEndGame', myRoomId);
        };
    } else {
        // Normaler Spielverlauf
        btnStartNextRound.innerText = "Nächste Runde starten";
        btnStartNextRound.onclick = () => {
            btnStartNextRound.classList.add('hidden'); // Button direkt verstecken gegen Doppel-Klicks
            socket.emit('nextQuestion', myRoomId);
        };
    }
}
});


// Finale Siegerehrung
socket.on('gameEnded', (players) => {
    if (amIHost) {
        btnStartNextRound.classList.add('hidden');
        hostControls.classList.add('hidden');
    }

    console.log("Spiel beendet. Ergebnisse:", players);
    
    // 1. Umschalten auf die Endphase
    showGamePhase('phase-end-results');

    const rematchBtn = document.getElementById('btn-rematch');
    if (rematchBtn) {
        if (amIHost) {
            rematchBtn.classList.remove('hidden'); // Host sieht ihn
        } else {
            rematchBtn.classList.add('hidden');    // Gäste sehen ihn nicht
        }
    }
    
    // 2. Container leeren
    const podiumList = document.getElementById('podium-list');
    podiumList.innerHTML = '';

    // 3. Spieler nach Punkten sortieren (höchste zuerst)
    const sortedPlayers = [...players].sort((a, b) => b.points - a.points);

    // 4. Liste aufbauen
    sortedPlayers.forEach((p, index) => {
        const resultRow = document.createElement('div');
        resultRow.className = 'neon-border-blue';
        resultRow.style.margin = '15px 0';
        resultRow.style.padding = '20px';
        resultRow.style.background = 'rgba(20, 20, 20, 0.8)';
        resultRow.style.borderRadius = '10px';
        resultRow.style.display = 'flex';
        resultRow.style.justifyContent = 'space-between';
        resultRow.style.alignItems = 'center';

        // Emojis für die ersten drei Plätze
        let rankLabel = `${index + 1}.`;
        if (index === 0) rankLabel = "👑 1.";
        if (index === 1) rankLabel = "🥈 2.";
        if (index === 2) rankLabel = "🥉 3.";

        resultRow.innerHTML = `
            <span style="font-size: 1.5rem; color: #fff; font-weight: bold;">${rankLabel} ${p.name}</span>
            <span style="font-size: 1.5rem; color: var(--neon-green); font-weight: bold;">${p.points} Pkt.</span>
        `;
        
        podiumList.appendChild(resultRow);
    });

    // 5. Sidebar verstecken (optional, damit das Podium mehr Platz hat)
    document.getElementById('game-header').classList.add('hidden');
});

socket.on('rematchStarted', (players) => {
    // Zurück in die Lobby
    showTicks = false;
    updatePlayerListUI(players);
    showGamePhase('phase-lobby');
    
    // Header wieder einblenden (falls er versteckt wurde)
    gameHeader.classList.remove('hidden');
    
    // Host-Start-Button wieder zeigen
    if (amIHost) {
        hostControls.classList.remove('hidden');
        btnStartGame.classList.remove('hidden');
        // Reset des "Nächste Runde" Buttons für den nächsten Durchgang
        btnStartNextRound.innerText = "Nächste Runde starten";
        btnStartNextRound.style.background = "";
        btnStartNextRound.style.boxShadow = "";
    }
});

socket.on('youAreHost', () => {
    amIHost = true;
    hostControls.classList.remove('hidden');
    // Falls wir in der Lobby sind, Start-Button zeigen
    if (phaseLobby.classList.contains('hidden') === false) {
        btnStartGame.classList.remove('hidden');
    }
    alert("Der Host hat das Spiel verlassen. Du bist jetzt der neue Host!");
});


socket.on('error', (msg) => alert(msg));





