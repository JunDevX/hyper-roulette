const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let searchQueue = [];
let activeRooms = {}; 

function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const length = Math.floor(Math.random() * 6) + 5; 
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

io.on('connection', (socket) => {
    socket.userData = null;
    socket.roomToken = null;
    socket.lastMessageTime = 0;

    socket.on('register', (data) => {
        socket.userData = {
            username: data.username || 'Аноним',
            discord: data.discord || 'none',
            telegram: data.telegram || 'none',
            id: socket.id
        };
        
        findMatch(socket);
    });

    // Проброс WebRTC сигналов внутри текущей комнаты для звонков и трансляций
    socket.on('rtc_signal', (data) => {
        if (!socket.roomToken || !activeRooms[socket.roomToken]) return;
        const room = activeRooms[socket.roomToken];
        const partner = room.p1.id === socket.id ? room.p2 : room.p1;
        partner.emit('rtc_signal', data);
    });

    socket.on('chat_message', (text) => {
        if (!socket.roomToken || !activeRooms[socket.roomToken]) return;
        
        const now = Date.now();
        if (now - socket.lastMessageTime < 5000) {
            socket.emit('bot_message', { text: 'Предупреждение: Отправлять сообщения можно раз в 5 секунд.' });
            return;
        }
        socket.lastMessageTime = now;

        const room = activeRooms[socket.roomToken];

        if (text.startsWith('/')) {
            handleCommand(socket, text, room);
            return;
        }

        room.messages.push({ user: socket.userData.username, text: text });
        io.to(socket.roomToken).emit('msg', { user: socket.userData.username, text: text });
    });

    socket.on('skip_user', () => {
        handleSkip(socket);
    });

    socket.on('disconnect', () => {
        if (socket.searchTimeout) clearTimeout(socket.searchTimeout);
        searchQueue = searchQueue.filter(s => s.id !== socket.id);
        handleSkip(socket, true);
    });
});

function findMatch(socket) {
    if (searchQueue.length > 0) {
        const partner = searchQueue.shift();
        const token = generateToken();

        socket.roomToken = token;
        partner.roomToken = token;

        socket.join(token);
        partner.join(token);

        activeRooms[token] = {
            p1: socket,
            p2: partner,
            messages: []
        };

        if (socket.searchTimeout) clearTimeout(socket.searchTimeout);
        if (partner.searchTimeout) clearTimeout(partner.searchTimeout);

        io.to(token).emit('system_start', {
            token: token,
            p1Name: socket.userData.username,
            p2Name: partner.userData.username
        });
    } else {
        searchQueue.push(socket);
        socket.emit('waiting', 'Поиск собеседника...');

        if (socket.searchTimeout) clearTimeout(socket.searchTimeout);
        socket.searchTimeout = setTimeout(() => {
            const index = searchQueue.findIndex(s => s.id === socket.id);
            if (index !== -1 && !socket.roomToken) {
                searchQueue.splice(index, 1); 
                socket.emit('search_timeout');
            }
        }, 15000); 
    }
}

function handleCommand(socket, text, room) {
    const partner = room.p1.id === socket.id ? room.p2 : room.p1;
    const args = text.split(' ');
    const baseCmd = args[0];

    if (baseCmd === '/send') {
        const sub = args[1];
        if (sub === 'discord') {
            partner.emit('bot_message', { text: `Социальные сети ${socket.userData.username}: Discord - ${socket.userData.discord}` });
            socket.emit('bot_message', { text: `Вы отправили свой Discord собеседнику.` });
        } else if (sub === 'telegram') {
            partner.emit('bot_message', { text: `Социальные сети ${socket.userData.username}: Telegram - ${socket.userData.telegram}` });
            socket.emit('bot_message', { text: `Вы отправили свой Telegram собеседнику.` });
        } else {
            socket.emit('bot_message', { text: 'Неверный аргумент. Используйте /send discord или /send telegram' });
        }
    } else if (baseCmd === '/skip') {
        handleSkip(socket);
    } else if (baseCmd === '/report') {
        socket.emit('trigger_report', { partnerName: partner.userData.username, token: socket.roomToken });
    }
}

function handleSkip(socket, isDisconnect = false) {
    const token = socket.roomToken;
    if (!token || !activeRooms[token]) return;

    const room = activeRooms[token];
    const partner = room.p1.id === socket.id ? room.p2 : room.p1;

    let logText = `Переписка ${socket.userData.username}\nБЛАНК:\n`;
    logText += `Discord: ${socket.userData.discord}\n`;
    logText += `Telegram: ${socket.userData.telegram}\n`;
    logText += `Token: ${token}\n`;
    logText += `- - - - -- - - -- - -\n`;
    
    room.messages.forEach(m => {
        logText += `<${m.user}> - ${m.text}\n`;
    });

    partner.emit('system_skipped', {
        logData: logText,
        partnerName: socket.userData.username,
        token: token
    });

    socket.leave(token);
    partner.leave(token);
    delete activeRooms[token];

    socket.roomToken = null;
    partner.roomToken = null;

    if (!isDisconnect) {
        findMatch(socket);
    }
    findMatch(partner);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});