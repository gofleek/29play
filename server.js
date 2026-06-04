const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const PORT = 3000;

const SUITS     = ["♠","♥","♦","♣"];
const VALUES    = ["7","8","Q","K","10","A","9","J"];
const POINT_MAP = { J:3, 9:2, A:1, 10:1, K:0, Q:0, 8:0, 7:0 };
const RANK_MAP  = { J:8, 9:7, A:6, 10:5, K:4, Q:3, 8:2, 7:1 };
const SEAT_NAMES= ["South","West","North","East"];
const AI_TAKEOVER_MS   = 20 * 1000;
const ROOM_IDLE_CLEANUP= 2 * 60 * 60 * 1000;

// ═══════════════ CHIPS ECONOMY ═══════════════
const CHIPS_GUEST_START    = 10;   // guest default chips
const CHIPS_REG_START      = 100;  // new registered user chips
const CHIPS_SIT_COST       = 2;    // everyone pays 2 to sit
const CHIPS_WIN_EACH       = 4;    // each winner gets 4 (4×2=8 per team)

// ════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════
const DATA_DIR     = path.join(process.cwd(), "data");
const ROOMS_FILE   = path.join(DATA_DIR, "rooms.json");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const MATCHES_FILE = path.join(DATA_DIR, "matches.json");
const USERS_FILE   = path.join(DATA_DIR, "users.json");
const GUESTS_FILE  = path.join(DATA_DIR, "guests.json");

try { if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
catch(e){ console.error("FATAL: Cannot create data directory:", e.message); }

function saveJSON(fp,data){ const t=fp+".tmp"; try{fs.writeFileSync(t,JSON.stringify(data,null,2));fs.renameSync(t,fp);}catch(e){console.error(`Failed to save ${fp}:`,e.message);} }
function loadJSON(fp,fb){ try{if(fs.existsSync(fp))return JSON.parse(fs.readFileSync(fp,"utf8"));}catch(e){console.error(`Failed to load ${fp}:`,e.message);}return fb; }

let playersDB = loadJSON(PLAYERS_FILE, {});
let matchesDB = loadJSON(MATCHES_FILE, []);
// usersDB: { username → { username, passwordHash, salt, displayName, createdAt, chips, wins, losses, handsPlayed, roomsCreated, transfers:[] } }
let usersDB   = loadJSON(USERS_FILE, {});
// guestsDB: { clientId → { name, chips, createdAt } }
let guestsDB  = loadJSON(GUESTS_FILE, {});

function saveAll() {
    const snap={};
    for(const[id,room]of rooms.entries()) snap[id]=serializeRoom(room);
    saveJSON(ROOMS_FILE,snap);
    saveJSON(PLAYERS_FILE,playersDB);
    saveJSON(MATCHES_FILE,matchesDB);
    saveJSON(USERS_FILE,usersDB);
    saveJSON(GUESTS_FILE,guestsDB);
}

const SKIP_ON_SAVE=new Set(["lastActivityPerSeat"]);
function serializeRoom(room){const o={};for(const[k,v]of Object.entries(room)){if(!SKIP_ON_SAVE.has(k))o[k]=v;}return o;}

setInterval(saveAll,30*1000);
process.on("SIGTERM",()=>{saveAll();process.exit(0);});
process.on("SIGINT",()=>{saveAll();process.exit(0);});

// ════════════════════════════════════════════════════════
//  AUTH HELPERS
// ════════════════════════════════════════════════════════
function hashPassword(p,s){return crypto.createHmac("sha256",s).update(p).digest("hex");}
function generateSalt(){return crypto.randomBytes(16).toString("hex");}
function generateToken(){return crypto.randomBytes(24).toString("hex");}

const sessions=new Map(); // token→{username,createdAt}
const SESSION_TTL=7*24*60*60*1000;

function createSession(username){const t=generateToken();sessions.set(t,{username,createdAt:Date.now()});return t;}
function getSession(token){if(!token)return null;const s=sessions.get(token);if(!s)return null;if(Date.now()-s.createdAt>SESSION_TTL){sessions.delete(token);return null;}return s;}
function getUserFromToken(token){const s=getSession(token);if(!s)return null;return usersDB[s.username]||null;}

setInterval(()=>{for(const[t,s]of sessions.entries())if(Date.now()-s.createdAt>SESSION_TTL)sessions.delete(t);},60*60*1000);

// ════════════════════════════════════════════════════════
//  CHIPS HELPERS
// ════════════════════════════════════════════════════════
function getUserChips(username){ return usersDB[username]?.chips ?? 0; }
function getGuestChips(clientId){ return guestsDB[clientId]?.chips ?? CHIPS_GUEST_START; }

function deductChips(username, clientId, amount){
    if(username && usersDB[username]){
        if(usersDB[username].chips < amount) return false;
        usersDB[username].chips -= amount;
        return true;
    }
    // guest
    if(!guestsDB[clientId]) guestsDB[clientId]={chips:CHIPS_GUEST_START,createdAt:Date.now()};
    if(guestsDB[clientId].chips < amount) return false;
    guestsDB[clientId].chips -= amount;
    return true;
}

function awardChips(username, clientId, amount){
    if(username && usersDB[username]){
        usersDB[username].chips = (usersDB[username].chips||0) + amount;
    } else {
        if(!guestsDB[clientId]) guestsDB[clientId]={chips:CHIPS_GUEST_START,createdAt:Date.now()};
        guestsDB[clientId].chips = (guestsDB[clientId].chips||0) + amount;
    }
}

function getPlayerChips(username, clientId){
    if(username && usersDB[username]) return usersDB[username].chips||0;
    if(!guestsDB[clientId]) guestsDB[clientId]={chips:CHIPS_GUEST_START,createdAt:Date.now()};
    return guestsDB[clientId].chips;
}

// ════════════════════════════════════════════════════════
//  PLAYER TRACKING
// ════════════════════════════════════════════════════════
function trackPlayer(clientId, name){
    const now=Date.now();
    if(!playersDB[clientId]){playersDB[clientId]={name,firstSeen:now,lastSeen:now,roomsPlayed:0,handsPlayed:0,wins:0,losses:0};}
    else{playersDB[clientId].name=name;playersDB[clientId].lastSeen=now;}
}

function recordMatch(room){
    const players=room.seats
        .map((s,i)=>s?{name:s.name,clientId:s.clientId,username:s.username||null,seat:SEAT_NAMES[i],team:(i===0||i===2)?1:2}:null)
        .filter(Boolean);

    const matchId=room.id+'_'+room.handNumber+'_'+Date.now().toString(36);
    matchesDB.push({matchId,roomId:room.id,roomName:room.name,finishedAt:Date.now(),
        handNumber:room.handNumber,winner:room.matchWinner,team1Score:room.team1Score,
        team2Score:room.team2Score,players,ownerUsername:room.ownerUsername||null});
    if(matchesDB.length>500) matchesDB=matchesDB.slice(-500);

    // Award chips: 4 per winning player
    players.forEach(p=>{
        const isWinner=p.team===room.matchWinner;
        if(playersDB[p.clientId]){
            playersDB[p.clientId].handsPlayed+=room.handNumber;
            if(isWinner) playersDB[p.clientId].wins++;
            else playersDB[p.clientId].losses=(playersDB[p.clientId].losses||0)+1;
        }
        if(isWinner){
            awardChips(p.username,p.clientId,CHIPS_WIN_EACH);
            if(p.username&&usersDB[p.username]){
                usersDB[p.username].wins=(usersDB[p.username].wins||0)+1;
                usersDB[p.username].handsPlayed=(usersDB[p.username].handsPlayed||0)+room.handNumber;
            }
        } else {
            if(p.username&&usersDB[p.username]){
                usersDB[p.username].losses=(usersDB[p.username].losses||0)+1;
                usersDB[p.username].handsPlayed=(usersDB[p.username].handsPlayed||0)+room.handNumber;
            }
        }
    });
    saveAll();
}

// ════════════════════════════════════════════════════════
//  ROOM STORE
// ════════════════════════════════════════════════════════
const rooms=new Map();

function makeRoomId(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let id="";for(let i=0;i<6;i++)id+=c[Math.floor(Math.random()*c.length)];return rooms.has(id)?makeRoomId():id;}

function createRoom(name,password,hostClientId,hostName,ownerUsername,theme){
    const id=makeRoomId();
    const room=makeBlankRoom(id,name,password,ownerUsername,theme);
    addRoomLog(room,`Room "${room.name}" created by ${hostName}.`,"system");
    rooms.set(id,room);
    if(ownerUsername&&usersDB[ownerUsername]) usersDB[ownerUsername].roomsCreated=(usersDB[ownerUsername].roomsCreated||0)+1;
    saveAll();
    return room;
}

function makeBlankRoom(id,name,password,ownerUsername,theme){
    return {
        id, name:(name||"Game Room").trim().slice(0,30),
        password:(password||"").trim(),
        ownerUsername:ownerUsername||null,
        createdAt:Date.now(), lastActivity:Date.now(),
        theme:theme||{bgColor:"#06080d",tableColor:"#0a1828",borderColor:"#1c2f50",bgImage:null,accentColor:"#ffd54f"},
        conditions:{
            entryCost:0,        // chips to enter the room (view)
            allowGuests:true,
            spectatorMode:false,
            minChips:0,         // min chips required to sit
        },
        phase:"waiting", deck:[], playerHands:[[],[],[],[]],
        seats:[null,null,null,null],
        biddingTurn:0, currentBid:15, highestBidder:-1,
        biddingPassedPlayers:[],
        trumpSuit:null, trumpRevealed:false,
        currentTrick:[], leadSuit:null, currentTurn:0,
        team1Points:0, team2Points:0, trickCount:0,
        awaitingTrickClear:false, matchFinished:false,
        team1Score:0, team2Score:0, handNumber:0,
        pendingHandResult:null, matchOver:false, matchWinner:null,
        lastActivityPerSeat:[Date.now(),Date.now(),Date.now(),Date.now()],
        aiTakeover:[false,false,false,false],
        gameLog:[],
    };
}

// ════════════════════════════════════════════════════════
//  LOAD ROOMS FROM DISK
// ════════════════════════════════════════════════════════
function loadRoomsFromDisk(){
    const snap=loadJSON(ROOMS_FILE,{});
    let count=0;
    for(const[id,data]of Object.entries(snap)){
        if(Date.now()-(data.lastActivity||0)>ROOM_IDLE_CLEANUP)continue;
        data.lastActivityPerSeat=[Date.now(),Date.now(),Date.now(),Date.now()];
        data.aiTakeover=[false,false,false,false];
        const hadNoHumans=[0,1,2,3].every(i=>!data.seats[i]);
        if(["bidding","trump","playing","finished"].includes(data.phase)&&hadNoHumans){
            data.phase="waiting";data.seats=[null,null,null,null];
            data.playerHands=[[],[],[],[]];data.currentTrick=[];
            data.leadSuit=null;data.awaitingTrickClear=false;
            data.matchFinished=false;data.pendingHandResult=null;
            addRoomLog(data,"⚡ Server restarted — room reset.","system");
            rooms.set(id,data);count++;continue;
        }
        if(["bidding","trump","playing"].includes(data.phase)){addRoomLog(data,"⚡ Server restarted — AI resumed all seats.","system");data.aiTakeover=[true,true,true,true];}
        if(!Array.isArray(data.playerHands))data.playerHands=[[],[],[],[]];
        if(!Array.isArray(data.seats))data.seats=[null,null,null,null];
        if(!data.theme)data.theme={bgColor:"#06080d",tableColor:"#0a1828",borderColor:"#1c2f50",bgImage:null,accentColor:"#ffd54f"};
        if(!data.conditions)data.conditions={entryCost:0,allowGuests:true,spectatorMode:false,minChips:0};
        if(!data.conditions.entryCost)data.conditions.entryCost=0;
        if(!data.conditions.minChips)data.conditions.minChips=0;
        if(!data.ownerUsername)data.ownerUsername=null;
        rooms.set(id,data);count++;
        if(data.phase==="bidding")setTimeout(()=>{if(rooms.get(id)?.phase==="bidding")runAiBidLoop(data);},3000);
        else if(data.phase==="trump")setTimeout(()=>{const r=rooms.get(id);if(r?.phase==="trump")setTrump(r,r.highestBidder,smartTrump(r,r.highestBidder));},3000);
        else if(data.phase==="playing")setTimeout(()=>{const r=rooms.get(id);if(!r||r.phase!=="playing")return;if(r.awaitingTrickClear&&r.currentTrick?.length===4)resolveTrick(r);else runAiLoop(r);},3000);
    }
    console.log(`Loaded ${count} room(s) from disk.`);
}

// ════════════════════════════════════════════════════════
//  ROOM HELPERS
// ════════════════════════════════════════════════════════
function addRoomLog(room,msg,type=""){room.gameLog.push({msg,type});if(room.gameLog.length>80)room.gameLog.shift();room.lastActivity=Date.now();}
function getPlayerLabel(room,i){const s=room.seats[i];if(room.aiTakeover[i])return `${SEAT_NAMES[i]}(AI🤖)`;return s?`${SEAT_NAMES[i]}(${s.name})`:`${SEAT_NAMES[i]}(AI)`;}
function touchSeat(room,i){room.lastActivityPerSeat[i]=Date.now();room.lastActivity=Date.now();}

// ════════════════════════════════════════════════════════
//  DECK / RESET / START
// ════════════════════════════════════════════════════════
function createDeck(){const d=[];for(const s of SUITS)for(const v of VALUES)d.push({suit:s,value:v,points:POINT_MAP[v],rank:RANK_MAP[v]});return d;}
function shuffle(d){for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}}
function sortHand(h){h.sort((a,b)=>a.suit===b.suit?b.rank-a.rank:a.suit.localeCompare(b.suit));}

function resetHand(room){
    room.phase="waiting";room.deck=[];room.playerHands=[[],[],[],[]];
    room.currentTrick=[];room.leadSuit=null;room.currentTurn=0;
    room.team1Points=0;room.team2Points=0;room.trickCount=0;
    room.awaitingTrickClear=false;room.matchFinished=false;
    room.biddingTurn=0;room.currentBid=15;room.highestBidder=-1;
    room.biddingPassedPlayers=[];room.trumpSuit=null;room.trumpRevealed=false;
    room.pendingHandResult=null;room.aiTakeover=[false,false,false,false];
    room.lastActivityPerSeat=[Date.now(),Date.now(),Date.now(),Date.now()];
}

function startHand(room){
    resetHand(room);room.handNumber++;
    room.phase="bidding";room.deck=createDeck();shuffle(room.deck);
    room.playerHands=[[],[],[],[]];
    for(let i=0;i<16;i++)room.playerHands[i%4].push(room.deck[i]);
    for(let i=0;i<4;i++)sortHand(room.playerHands[i]);
    room.biddingTurn=Math.floor(Math.random()*4);
    addRoomLog(room,`🃏 Hand #${room.handNumber} — BIDDING. ${getPlayerLabel(room,room.biddingTurn)} starts.`,"system");
    addRoomLog(room,`📊 Score: S+N ${room.team1Score} | W+E ${room.team2Score}`,"system");
    touchSeat(room,room.biddingTurn);
    runAiBidLoop(room);saveAll();return true;
}

// ════════════════════════════════════════════════════════
//  BIDDING
// ════════════════════════════════════════════════════════
function processBid(room,pi,action,value){
    if(room.phase!=="bidding"||room.biddingTurn!==pi||room.biddingPassedPlayers.includes(pi))return false;
    if(action==="pass"){room.biddingPassedPlayers.push(pi);addRoomLog(room,`${getPlayerLabel(room,pi)} passed`);}
    else if(action==="bid"){const bid=parseInt(value);if(isNaN(bid)||bid<=room.currentBid||bid<16||bid>28)return false;room.currentBid=bid;room.highestBidder=pi;addRoomLog(room,`${getPlayerLabel(room,pi)} bid ${bid}`);}
    else return false;
    if(room.biddingPassedPlayers.length===3&&room.highestBidder!==-1){endBidding(room);return true;}
    if(room.biddingPassedPlayers.length===4){addRoomLog(room,"All passed — restarting","system");room.biddingPassedPlayers=[];room.currentBid=15;room.highestBidder=-1;}
    advanceBidTurn(room);touchSeat(room,room.biddingTurn);runAiBidLoop(room);return true;
}
function advanceBidTurn(room){let next=(room.biddingTurn+3)%4,l=0;while(room.biddingPassedPlayers.includes(next)&&l<5){next=(next+3)%4;l++;}if(!room.biddingPassedPlayers.includes(next))room.biddingTurn=next;}
function endBidding(room){addRoomLog(room,`🏅 ${getPlayerLabel(room,room.highestBidder)} won bid at ${room.currentBid}!`,"system");room.phase="trump";touchSeat(room,room.highestBidder);const isAi=!room.seats[room.highestBidder]||room.aiTakeover[room.highestBidder];if(isAi)setTimeout(()=>{const s=smartTrump(room,room.highestBidder);setTrump(room,room.highestBidder,s);},1200);}
function runAiBidLoop(room){if(room.phase!=="bidding")return;const seat=room.biddingTurn;const isAi=!room.seats[seat]||room.aiTakeover[seat];if(!isAi)return;setTimeout(()=>{if(room.phase!=="bidding"||room.biddingTurn!==seat)return;if(!room.seats[seat]||room.aiTakeover[seat])aiBid(room,seat);},900);}
function aiBid(room,i){const d=smartBid(room,i);processBid(room,i,d.action,d.value||null);}

// ════════════════════════════════════════════════════════
//  TRUMP / PLAY
// ════════════════════════════════════════════════════════
function setTrump(room,pi,suit){
    if(room.phase!=="trump"||room.highestBidder!==pi||!SUITS.includes(suit))return false;
    room.trumpSuit=suit;room.trumpRevealed=false;
    addRoomLog(room,`🔒 Trump chosen by ${getPlayerLabel(room,pi)} (hidden)`,"system");
    for(let i=16;i<32;i++)room.playerHands[i%4].push(room.deck[i]);
    for(let i=0;i<4;i++)sortHand(room.playerHands[i]);
    room.phase="playing";room.currentTurn=room.highestBidder;
    addRoomLog(room,`▶ PLAY — ${getPlayerLabel(room,room.currentTurn)} leads`,"system");
    touchSeat(room,room.currentTurn);runAiLoop(room);return true;
}

function isValidMove(room,pi,card){if(!room.leadSuit)return true;const hasLead=room.playerHands[pi].some(c=>c.suit===room.leadSuit);return!hasLead||card.suit===room.leadSuit;}
function playCard(room,pi,ci){
    const hand=room.playerHands[pi];const card=hand[ci];
    if(!card||!isValidMove(room,pi,card))return false;
    hand.splice(ci,1);if(!room.leadSuit)room.leadSuit=card.suit;
    if(!room.trumpRevealed&&room.trumpSuit&&card.suit===room.trumpSuit&&room.leadSuit!==room.trumpSuit){room.trumpRevealed=true;addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room,pi)}`,"system");}
    room.currentTrick.push({player:pi,card});addRoomLog(room,`${getPlayerLabel(room,pi)} played ${card.value}${card.suit}`);
    room.currentTurn=(pi+3)%4;
    if(room.currentTrick.length===4){room.awaitingTrickClear=true;setTimeout(()=>resolveTrick(room),1500);}
    else touchSeat(room,room.currentTurn);
    return true;
}
function runAiLoop(room){
    if(room.phase!=="playing"||room.awaitingTrickClear||room.matchFinished||room.matchOver)return;
    const seat=room.currentTurn;if(room.seats[seat]&&!room.aiTakeover[seat])return;
    setTimeout(()=>{
        if(room.phase!=="playing"||room.awaitingTrickClear)return;
        const cur=room.currentTurn;if(room.seats[cur]&&!room.aiTakeover[cur])return;
        if(!room.trumpRevealed&&room.trumpSuit&&room.leadSuit){const hasLead=room.playerHands[cur].some(c=>c.suit===room.leadSuit);if(!hasLead&&shouldAiRevealTrump(room,cur)){room.trumpRevealed=true;addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room,cur)}`,"system");}}
        const card=smartPlayCard(room,cur);const idx=room.playerHands[cur].findIndex(c=>c.suit===card.suit&&c.value===card.value);
        playCard(room,cur,idx);runAiLoop(room);
    },900);
}

// ════════════════════════════════════════════════════════
//  SMART AI (unchanged)
// ════════════════════════════════════════════════════════
function evaluateHand(hand){let score=0;const sg={};for(const c of hand){if(!sg[c.suit])sg[c.suit]=[];sg[c.suit].push(c);}for(const c of hand){if(c.value==='J')score+=14;else if(c.value==='9')score+=10;else if(c.value==='A')score+=7;else if(c.value==='10')score+=6;else if(c.value==='K')score+=4;else if(c.value==='Q')score+=2;}for(const[,cards]of Object.entries(sg)){if(cards.length>=4)score+=(cards.length-3)*5;if(cards.length===1)score+=4;}const voids=4-Object.keys(sg).length;score+=voids*8;return score;}
function bestTrumpSuit(hand){const ss={};for(const suit of SUITS){const cards=hand.filter(c=>c.suit===suit);let s=0;for(const c of cards){if(c.value==='J')s+=20;else if(c.value==='9')s+=14;else if(c.value==='A')s+=8;else if(c.value==='10')s+=6;else if(c.value==='K')s+=4;else if(c.value==='Q')s+=2;s+=cards.length*2;}ss[suit]=s;}return SUITS.reduce((best,s)=>ss[s]>ss[best]?s:best,SUITS[0]);}
function smartBid(room,si){const hand=room.playerHands[si];const strength=evaluateHand(hand);const myTeam=(si===0||si===2)?1:2;const myScore=myTeam===1?room.team1Score:room.team2Score;const oppScore=myTeam===1?room.team2Score:room.team1Score;const current=room.currentBid;const partner=(si+2)%4;const partnerBid=room.highestBidder===partner;const opponentBidding=!partnerBid&&room.highestBidder>=0;const desperate=myScore<=-4||(oppScore>=5&&myScore<oppScore);const comfortable=myScore>=3&&(myScore-oppScore)>=2;const needPoints=oppScore>=4;let baseBid;if(strength>=70)baseBid=22;else if(strength>=55)baseBid=20;else if(strength>=42)baseBid=18;else if(strength>=30)baseBid=17;else baseBid=16;if(desperate)baseBid+=2;if(comfortable)baseBid-=1;if(needPoints)baseBid+=1;if(partnerBid&&strength>=40&&current<baseBid)baseBid=Math.min(baseBid,current+2);baseBid=Math.min(baseBid,28);if(baseBid<=current){if(opponentBidding&&desperate&&strength>=35)return{action:'bid',value:Math.min(current+1,28)};return{action:'pass'};}if(strength<28&&current>=24)return{action:'pass'};return{action:'bid',value:baseBid};}
function smartTrump(room,si){return bestTrumpSuit(room.playerHands[si]);}
function smartPlayCard(room,si){const hand=room.playerHands[si];const trick=room.currentTrick;const trump=room.trumpSuit;const lead=room.leadSuit;const partner=(si+2)%4;const myTeam=(si===0||si===2)?1:2;const myScore=myTeam===1?room.team1Score:room.team2Score;const valid=hand.filter(c=>{if(!lead)return true;const hasLead=hand.some(x=>x.suit===lead);return!hasLead||c.suit===lead;});if(!valid.length)return hand[0];const trickPoints=trick.reduce((s,t)=>s+t.card.points,0);const trickLen=trick.length;function cardPower(c){let p=c.rank;if(trump&&c.suit===trump)p+=100;return p;}function trickWinner(t){let best=-1,winner=-1;for(const p of t){let sc=p.card.rank;if(trump&&p.card.suit===trump)sc+=100;else if(lead&&p.card.suit!==lead)sc=-1;if(sc>best){best=sc;winner=p.player;}}return winner;}const byAsc=[...valid].sort((a,b)=>cardPower(a)-cardPower(b));const byDesc=[...byAsc].reverse();const currentWinner=trick.length>0?trickWinner(trick):-1;const partnerWinning=currentWinner===partner;const weWinning=currentWinner===si||(trick.length>0&&((currentWinner===0||currentWinner===2)===(myTeam===1)));function canBeat(c){return trickWinner([...trick,{player:si,card:c}])===si;}const beaters=valid.filter(canBeat).sort((a,b)=>cardPower(a)-cardPower(b));if(trickLen===0){const trumpCards=valid.filter(c=>trump&&c.suit===trump);const nonTrump=valid.filter(c=>!trump||c.suit!==trump);if(room.trumpRevealed&&trumpCards.length>=2){const jn=trumpCards.find(c=>c.value==='J'||c.value==='9');if(jn)return jn;}const aces=nonTrump.filter(c=>c.value==='A');if(aces.length)return aces[0];const tens=nonTrump.filter(c=>c.value==='10');if(tens.length&&trickPoints===0)return tens[0];if(myScore<=-4&&trumpCards.length)return byDesc[0];const safe=nonTrump.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);return safe.length?safe[0]:byAsc[0];}if(partnerWinning){const pts=valid.filter(c=>c.points>0).sort((a,b)=>b.points-a.points);if(pts.length)return pts[0];return byAsc[0];}if(trickLen===3){if(weWinning||partnerWinning){const pts=valid.filter(c=>c.points>0).sort((a,b)=>b.points-a.points);return pts.length?pts[0]:byAsc[0];}if(beaters.length)return beaters[0];const dump=valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);return dump.length?dump[0]:byAsc[0];}if(beaters.length){if(trickPoints>=2||myScore<=-3)return beaters[0];const dump=valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);if(dump.length)return dump[0];return beaters[0];}const dumpable=valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);return dumpable.length?dumpable[0]:byAsc[0];}
function shouldAiRevealTrump(room,si){if(!room.leadSuit||room.trumpRevealed||!room.trumpSuit)return false;const hasLead=room.playerHands[si].some(c=>c.suit===room.leadSuit);if(hasLead)return false;const trickPoints=room.currentTrick.reduce((s,t)=>s+t.card.points,0);const trumpCards=room.playerHands[si].filter(c=>c.suit===room.trumpSuit);const hasStrong=trumpCards.some(c=>c.value==='J'||c.value==='9'||c.value==='A');return hasStrong&&trickPoints>=2;}

function resolveTrick(room){
    if(!room.awaitingTrickClear)return;
    let winner=-1,best=-1;
    for(const p of room.currentTrick){let sc=p.card.rank;if(p.card.suit===room.trumpSuit)sc+=100;else if(p.card.suit!==room.leadSuit)sc=-1;if(sc>best){best=sc;winner=p.player;}}
    let pts=0;room.currentTrick.forEach(t=>pts+=t.card.points);
    if(winner===0||winner===2)room.team1Points+=pts;else room.team2Points+=pts;
    addRoomLog(room,`🏆 ${getPlayerLabel(room,winner)} won trick`);
    room.currentTrick=[];room.leadSuit=null;room.currentTurn=winner;
    room.awaitingTrickClear=false;room.trickCount++;
    if(room.trickCount>=8){endHand(room);return;}
    touchSeat(room,room.currentTurn);runAiLoop(room);
}

function endHand(room){
    room.phase="finished";room.matchFinished=true;
    const bidTeam=(room.highestBidder===0||room.highestBidder===2)?1:2;
    const bidPts=bidTeam===1?room.team1Points:room.team2Points;
    const made=bidPts>=room.currentBid;
    let d1=0,d2=0;
    if(made){if(bidTeam===1)d1=+1;else d2=+1;addRoomLog(room,`✅ Team ${bidTeam} made bid of ${room.currentBid}`,"system");}
    else{if(bidTeam===1)d1=-1;else d2=-1;addRoomLog(room,`❌ Team ${bidTeam} failed bid of ${room.currentBid}`,"system");}
    room.team1Score+=d1;room.team2Score+=d2;
    room.pendingHandResult={bidTeam,bidMade:made,delta1:d1,delta2:d2,handNumber:room.handNumber};
    addRoomLog(room,`📊 Match: S+N ${room.team1Score} | W+E ${room.team2Score}`,"system");
    checkMatchOver(room);saveAll();
    if(!room.matchOver)setTimeout(()=>{if(room.phase==="finished"&&!room.matchOver)startHand(room);},3500);
}
function checkMatchOver(room){
    const t1=room.team1Score,t2=room.team2Score;
    if(t1>=6||t2<=-6){room.matchOver=true;room.matchWinner=1;room.phase="matchOver";addRoomLog(room,`🏆 South+North win! (${t1} vs ${t2})`,"system");recordMatch(room);}
    else if(t2>=6||t1<=-6){room.matchOver=true;room.matchWinner=2;room.phase="matchOver";addRoomLog(room,`🏆 West+East win! (${t1} vs ${t2})`,"system");recordMatch(room);}
}

// ════════════════════════════════════════════════════════
//  SEAT MANAGEMENT
// ════════════════════════════════════════════════════════
function sitPlayer(room,seat,clientId,name,username){
    for(let i=0;i<4;i++)if(room.seats[i]?.clientId===clientId)room.seats[i]=null;
    room.seats[seat]={clientId,name,username:username||null};
    room.aiTakeover[seat]=false;touchSeat(room,seat);
    addRoomLog(room,`${name} sat at ${SEAT_NAMES[seat]}`+(username?` (@${username})`:' (guest)'),"system");
    trackPlayer(clientId,name);
    playersDB[clientId].roomsPlayed++;
    saveAll();
}
function standPlayer(room,clientId){
    for(let i=0;i<4;i++){
        if(room.seats[i]?.clientId===clientId){
            addRoomLog(room,`${room.seats[i].name} left ${SEAT_NAMES[i]}`,"system");
            room.seats[i]=null;
            if(["bidding","trump","playing"].includes(room.phase)&&!room.matchOver){
                room.aiTakeover[i]=true;addRoomLog(room,`🤖 AI took over ${SEAT_NAMES[i]}`,"system");
                if(room.phase==="bidding"&&room.biddingTurn===i)setTimeout(()=>aiBid(room,i),400);
                else if(room.phase==="trump"&&room.highestBidder===i)setTimeout(()=>setTrump(room,i,smartTrump(room,i)),600);
                else if(room.phase==="playing"&&room.currentTurn===i&&!room.awaitingTrickClear)setTimeout(()=>runAiLoop(room),400);
            }
        }
    }
    saveAll();
}

// ════════════════════════════════════════════════════════
//  AI WATCHDOG / ROOM CLEANUP
// ════════════════════════════════════════════════════════
function checkAllRooms(){
    for(const room of rooms.values()){
        if(!["bidding","trump","playing"].includes(room.phase)||room.matchOver)continue;
        let activeSeat=-1;
        if(room.phase==="bidding")activeSeat=room.biddingTurn;
        else if(room.phase==="playing")activeSeat=room.currentTurn;
        else if(room.phase==="trump")activeSeat=room.highestBidder;
        if(activeSeat===-1)continue;
        const s=room.seats[activeSeat];if(!s||room.aiTakeover[activeSeat])continue;
        const elapsed=Date.now()-room.lastActivityPerSeat[activeSeat];
        if(elapsed>=AI_TAKEOVER_MS){
            room.aiTakeover[activeSeat]=true;room.seats[activeSeat]=null;
            addRoomLog(room,`⏰ ${s.name} unresponsive — AI took over ${SEAT_NAMES[activeSeat]}`,"system");
            if(room.phase==="bidding")setTimeout(()=>aiBid(room,activeSeat),300);
            else if(room.phase==="trump")setTimeout(()=>setTrump(room,activeSeat,smartTrump(room,activeSeat)),600);
            else runAiLoop(room);
        }
    }
}
setInterval(checkAllRooms,10000);
setInterval(()=>{const now=Date.now();for(const[id,room]of rooms.entries()){if(now-room.lastActivity>ROOM_IDLE_CLEANUP){rooms.delete(id);saveAll();}}},10*60*1000);
// Clean stale guests older than 30 days
setInterval(()=>{const cutoff=Date.now()-30*24*60*60*1000;for(const[id,g]of Object.entries(guestsDB)){if(g.createdAt<cutoff)delete guestsDB[id];}},24*60*60*1000);

// ════════════════════════════════════════════════════════
//  STATE SERIALISATION
// ════════════════════════════════════════════════════════
// viewers: roomId → Map(clientId → lastSeenTs)
const roomViewers = new Map();
const VIEWER_TTL = 10000; // 10s — slightly above 2s poll + latency buffer

function touchViewer(roomId, clientId){
    if(!clientId) return;
    if(!roomViewers.has(roomId)) roomViewers.set(roomId, new Map());
    roomViewers.get(roomId).set(clientId, Date.now());
}
function getViewerCount(roomId){
    const vm = roomViewers.get(roomId);
    if(!vm) return 0;
    const cutoff = Date.now() - VIEWER_TTL;
    let count = 0;
    for(const [cid, ts] of vm.entries()){
        if(ts >= cutoff) count++;
        else vm.delete(cid);
    }
    return count;
}
// Cleanup stale rooms from viewer map
setInterval(()=>{
    for(const [rid] of roomViewers.entries()) if(!rooms.has(rid)) roomViewers.delete(rid);
}, 60000);

function publicRoomState(room,clientId,username){
    touchViewer(room.id, clientId);
    const st=Object.assign({},room);
    if(!st.trumpRevealed&&st.phase==="playing"){const isWinner=clientId&&st.seats[st.highestBidder]?.clientId===clientId;if(!isWinner)st.trumpSuit=null;}
    st.deck=[];
    const mySeat=clientId?st.seats.findIndex(s=>s?.clientId===clientId):-1;
    st.playerHands=st.playerHands.map((h,i)=>i===mySeat?h:h.map(()=>({})));
    st.ownerDisplay=room.ownerUsername||null;
    st.myChips=getPlayerChips(username||null,clientId);
    st.sitCost=CHIPS_SIT_COST;
    st.winReward=CHIPS_WIN_EACH;
    st.viewerCount=getViewerCount(room.id);
    return st;
}

function lobbyList(){
    const list=[];
    for(const room of rooms.values()){
        const playerDetails=room.seats.map((s,i)=>s&&!room.aiTakeover[i]?s.name:null);
        const humanCount=playerDetails.filter(Boolean).length;
        list.push({
            id:room.id,name:room.name,passwordProtected:!!room.password,
            phase:room.phase,players:humanCount,playerDetails,
            handNumber:room.handNumber,createdAt:room.createdAt,
            ownerUsername:room.ownerUsername||null,
            entryCost:room.conditions.entryCost||0,
            minChips:room.conditions.minChips||0,
            allowGuests:room.conditions.allowGuests!==false,
            theme:{bgColor:room.theme?.bgColor||"#06080d",tableColor:room.theme?.tableColor||"#0a1828",borderColor:room.theme?.borderColor||"#1c2f50",accentColor:room.theme?.accentColor||"#ffd54f"},
        });
    }
    return list.sort((a,b)=>b.createdAt-a.createdAt);
}

// ════════════════════════════════════════════════════════
//  HTTP SERVER
// ════════════════════════════════════════════════════════
const server=http.createServer((req,res)=>{
    const u=new URL(req.url,`http://localhost`);
    const pathname=u.pathname;

    const json=(data,code=200)=>{res.writeHead(code,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data));};
    const err=(msg,code=400)=>json({error:msg},code);
    const body=()=>new Promise(resolve=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{try{resolve(JSON.parse(b||"{}"))}catch{resolve({})}});});
    const getRoom=(id)=>{if(!id)return null;return rooms.get(id.toUpperCase())||null;};
    const getToken=()=>{const auth=req.headers["authorization"]||"";if(auth.startsWith("Bearer "))return auth.slice(7);return u.searchParams.get("token")||null;};

    // ── STATIC FILES ──────────────────────────────────────
    if(pathname==="/"&&req.method==="GET"){
        fs.readFile(path.join(__dirname,"landing.html"),(e,c)=>{if(e){res.writeHead(500);res.end("Cannot load landing.html");return;}res.writeHead(200,{"Content-Type":"text/html"});res.end(c);});return;
    }
    if(pathname==="/lobby"&&req.method==="GET"){
        fs.readFile(path.join(__dirname,"lobby.html"),(e,c)=>{if(e){res.writeHead(500);res.end("Cannot load lobby.html");return;}res.writeHead(200,{"Content-Type":"text/html"});res.end(c);});return;
    }
    if(pathname==="/game"&&req.method==="GET"){
        fs.readFile(path.join(__dirname,"user.html"),(e,c)=>{if(e){res.writeHead(500);res.end("Cannot load user.html");return;}res.writeHead(200,{"Content-Type":"text/html"});res.end(c);});return;
    }
    const staticMap={"/manifest.json":"application/manifest+json","/sw.js":"application/javascript"};
    if(staticMap[pathname]&&req.method==="GET"){fs.readFile(path.join(__dirname,pathname.slice(1)),(e,c)=>{if(e){res.writeHead(404);res.end("Not found");return;}res.writeHead(200,{"Content-Type":staticMap[pathname],"Cache-Control":pathname==="/sw.js"?"no-cache":"public,max-age=86400"});res.end(c);});return;}
    if(pathname.startsWith("/icons/")&&req.method==="GET"){const f=path.join(__dirname,"icons",path.basename(pathname));fs.readFile(f,(e,c)=>{if(e){res.writeHead(404);res.end("Not found");return;}res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public,max-age=604800"});res.end(c);});return;}

    // ══════════════════════════════════════════════════════
    //  AUTH ENDPOINTS
    // ══════════════════════════════════════════════════════
    if(pathname==="/api/auth/register"&&req.method==="POST"){
        body().then(b=>{
            const username=(b.username||"").trim().toLowerCase();
            const password=(b.password||"").trim();
            const displayName=(b.displayName||b.username||"").trim().slice(0,30);
            if(!username||username.length<3||username.length>20)return err("Username must be 3-20 characters");
            if(!/^[a-z0-9_]+$/.test(username))return err("Username: letters, numbers, underscore only");
            if(!password||password.length<6)return err("Password must be at least 6 characters");
            if(usersDB[username])return err("Username already taken");
            const salt=generateSalt();
            usersDB[username]={
                username,displayName:displayName||username,
                passwordHash:hashPassword(password,salt),salt,
                createdAt:Date.now(),chips:CHIPS_REG_START,
                wins:0,losses:0,handsPlayed:0,roomsCreated:0,transfers:[]
            };
            saveAll();
            const token=createSession(username);
            json({ok:true,token,user:publicUser(usersDB[username])});
        });return;
    }

    if(pathname==="/api/auth/login"&&req.method==="POST"){
        body().then(b=>{
            const username=(b.username||"").trim().toLowerCase();
            const password=(b.password||"").trim();
            const u2=usersDB[username];
            if(!u2)return err("Invalid username or password",401);
            if(hashPassword(password,u2.salt)!==u2.passwordHash)return err("Invalid username or password",401);
            const token=createSession(username);
            json({ok:true,token,user:publicUser(u2)});
        });return;
    }

    if(pathname==="/api/auth/logout"&&req.method==="POST"){const token=getToken();if(token)sessions.delete(token);json({ok:true});return;}

    if(pathname==="/api/auth/me"&&req.method==="GET"){
        const user=getUserFromToken(getToken());
        if(!user)return err("Not authenticated",401);
        json({ok:true,user:publicUser(user)});return;
    }

    // ── GUEST SESSION ─────────────────────────────────────
    if(pathname==="/api/guest/start"&&req.method==="POST"){
        body().then(b=>{
            const name=(b.name||"").trim().slice(0,8);
            if(!name||name.length<1)return err("Name required");
            const clientId=b.clientId||(crypto.randomBytes(8).toString("hex"));
            if(!guestsDB[clientId]){
                guestsDB[clientId]={name,chips:CHIPS_GUEST_START,createdAt:Date.now()};
            } else {
                guestsDB[clientId].name=name;
            }
            saveAll();
            json({ok:true,clientId,name:guestsDB[clientId].name,chips:guestsDB[clientId].chips});
        });return;
    }

    if(pathname==="/api/guest/me"&&req.method==="GET"){
        const clientId=u.searchParams.get("clientId");
        if(!clientId||!guestsDB[clientId])return err("Guest not found",404);
        const g=guestsDB[clientId];
        json({ok:true,name:g.name,chips:g.chips,clientId});return;
    }

    // ── CHIPS TRANSFER ────────────────────────────────────
    if(pathname==="/api/chips/transfer"&&req.method==="POST"){
        body().then(b=>{
            const user=getUserFromToken(b.token||getToken());
            if(!user)return err("Must be logged in to transfer chips",401);
            const toUsername=(b.to||"").trim().toLowerCase();
            const amount=parseInt(b.amount)||0;
            if(!toUsername||toUsername===user.username)return err("Invalid recipient");
            if(!usersDB[toUsername])return err("Recipient not found");
            if(amount<1||amount>1000)return err("Amount must be 1–1000");
            if(user.chips<amount)return err(`Not enough chips (you have ${user.chips})`);
            usersDB[user.username].chips-=amount;
            usersDB[toUsername].chips=(usersDB[toUsername].chips||0)+amount;
            const entry={from:user.username,to:toUsername,amount,at:Date.now()};
            usersDB[user.username].transfers=(usersDB[user.username].transfers||[]).concat(entry).slice(-50);
            usersDB[toUsername].transfers=(usersDB[toUsername].transfers||[]).concat(entry).slice(-50);
            saveAll();
            json({ok:true,yourChips:usersDB[user.username].chips,message:`Sent ${amount} chips to @${usersDB[toUsername].displayName}`});
        });return;
    }

    // ── DASHBOARD ─────────────────────────────────────────
    if(pathname==="/api/dashboard"&&req.method==="GET"){
        const user=getUserFromToken(getToken());
        if(!user)return err("Not authenticated",401);
        const myRooms=[];
        for(const room of rooms.values()){
            if(room.ownerUsername===user.username){
                myRooms.push({id:room.id,name:room.name,phase:room.phase,handNumber:room.handNumber,team1Score:room.team1Score,team2Score:room.team2Score,createdAt:room.createdAt,conditions:room.conditions,theme:room.theme,players:room.seats.filter((s,i)=>s&&!room.aiTakeover[i]).length});
            }
        }
        const myMatches=matchesDB.filter(m=>m.players?.some(p=>p.username===user.username)).slice(-20).reverse();
        const transfers=(user.transfers||[]).slice(-10).reverse();
        json({ok:true,user:publicUser(user),rooms:myRooms,recentMatches:myMatches,transfers});return;
    }

    // ── ROOM THEME ────────────────────────────────────────────
    if(pathname==="/api/room/theme"&&req.method==="PATCH"){
        body().then(b=>{
            const user=getUserFromToken(b.token||getToken());
            if(!user)return err("Not authenticated",401);
            const room=getRoom(b.roomId);
            if(!room)return err("Room not found",404);
            if(room.ownerUsername!==user.username)return err("Not room owner",403);
            if(!b.theme||typeof b.theme!=="object")return err("Invalid theme");
            const t=b.theme;
            if(t.bgColor)    room.theme.bgColor    =t.bgColor;
            if(t.tableColor) room.theme.tableColor =t.tableColor;
            if(t.borderColor)room.theme.borderColor=t.borderColor;
            if(t.accentColor)room.theme.accentColor=t.accentColor;
            if(t.bgImage===null) room.theme.bgImage=null;
            else if(typeof t.bgImage==="string"&&t.bgImage.startsWith("data:")&&t.bgImage.length<700000) room.theme.bgImage=t.bgImage;
            saveAll();
            json({ok:true,theme:room.theme});
        });return;
    }

    // ── ROOM CONDITIONS ───────────────────────────────────
    if(pathname==="/api/room/conditions"&&req.method==="PATCH"){
        body().then(b=>{
            const user=getUserFromToken(getToken());
            if(!user)return err("Not authenticated",401);
            const room=getRoom(b.roomId);
            if(!room)return err("Room not found",404);
            if(room.ownerUsername!==user.username)return err("Not room owner",403);
            const {allowGuests,spectatorMode,entryCost,minChips}=b;
            if(typeof allowGuests==="boolean")room.conditions.allowGuests=allowGuests;
            if(typeof spectatorMode==="boolean")room.conditions.spectatorMode=spectatorMode;
            if(entryCost!==undefined)room.conditions.entryCost=Math.max(0,parseInt(entryCost)||0);
            if(minChips!==undefined)room.conditions.minChips=Math.max(0,parseInt(minChips)||0);
            saveAll();
            json({ok:true,conditions:room.conditions});
        });return;
    }

    // ── LOBBY / STATS ─────────────────────────────────────
    if(pathname==="/api/lobby"&&req.method==="GET"){json(lobbyList());return;}

    if(pathname==="/api/stats"&&req.method==="GET"){
        const fiveMin=5*60*1000;let activeUsers=0;
        for(const room of rooms.values())room.seats.forEach((s,i)=>{if(s&&!room.aiTakeover[i]&&Date.now()-room.lastActivityPerSeat[i]<fiveMin)activeUsers++;});
        const activeRooms=[...rooms.values()].filter(r=>['bidding','trump','playing'].includes(r.phase)).length;
        json({
            totalMatches:matchesDB.length,activeUsers,activeRooms,
            recentMatches:matchesDB.slice(-20).reverse(),
            topPlayers:Object.entries(usersDB)
                .map(([,u2])=>({name:u2.displayName||u2.username,username:u2.username,wins:u2.wins||0,losses:u2.losses||0,handsPlayed:u2.handsPlayed||0,chips:u2.chips||0}))
                .filter(p=>(p.wins||0)+(p.losses||0)>0)
                .sort((a,b)=>b.wins!==a.wins?b.wins-a.wins:(b.chips-a.chips))
                .slice(0,20),
        });return;
    }

    // ── CREATE ROOM ───────────────────────────────────────
    if(pathname==="/api/room/create"&&req.method==="POST"){
        body().then(b=>{
            const user=getUserFromToken(b.token||getToken());
            if(!user)return err("Must be logged in to create a room",401);
            const room=createRoom(b.roomName,b.password,b.clientId,b.hostName||user.displayName||"Host",user.username,b.theme||null);
            if(b.conditions){
                if(typeof b.conditions.allowGuests==="boolean")room.conditions.allowGuests=b.conditions.allowGuests;
                if(typeof b.conditions.spectatorMode==="boolean")room.conditions.spectatorMode=b.conditions.spectatorMode;
                if(b.conditions.entryCost!==undefined)room.conditions.entryCost=Math.max(0,parseInt(b.conditions.entryCost)||0);
                if(b.conditions.minChips!==undefined)room.conditions.minChips=Math.max(0,parseInt(b.conditions.minChips)||0);
            }
            json({roomId:room.id});
        });return;
    }

    // ── JOIN ROOM (entry cost check) ──────────────────────
    if(pathname==="/api/room/join"&&req.method==="POST"){
        body().then(b=>{
            const room=getRoom(b.roomId);
            if(!room)return err("Room not found",404);
            if(room.password&&room.password!==b.password)return err("Wrong password",403);
            const sessionUser=getUserFromToken(b.token||getToken());
            const username=sessionUser?sessionUser.username:null;
            const clientId=b.clientId||null;

            // Guest check
            if(!username&&!room.conditions.allowGuests)
                return err("This room requires a registered account");

            // Entry cost
            const cost=room.conditions.entryCost||0;
            if(cost>0){
                const chips=getPlayerChips(username,clientId);
                if(chips<cost)return err(`This room costs ${cost} chips to enter. You have ${chips}.`);
                if(!deductChips(username,clientId,cost))return err("Not enough chips");
                addRoomLog(room,`${username||b.guestName||'Guest'} paid ${cost} chip${cost!==1?'s':''} to enter`,"system");
                saveAll();
            }
            json({ok:true,roomId:room.id,roomName:room.name,entryCostPaid:cost});
        });return;
    }

    // ── GAME STATE ────────────────────────────────────────
    if(pathname==="/api/state"&&req.method==="GET"){
        const room=getRoom(u.searchParams.get("room"));
        if(!room)return err("Room not found",404);
        const clientId=u.searchParams.get("clientId")||null;
        const sessionUser=getUserFromToken(getToken());
        json(publicRoomState(room,clientId,sessionUser?.username));return;
    }

    // ── GAME ACTIONS ──────────────────────────────────────
    const gameRoutes=["/api/start","/api/sit","/api/stand","/api/play","/api/bid","/api/trump","/api/reveal-trump"];
    if(gameRoutes.includes(pathname)&&req.method==="POST"){
        body().then(b=>{
            const room=getRoom(b.roomId);
            if(!room)return err("Room not found",404);
            const {clientId,seat,cardIndex,action,value,suit}=b;
            const sessionUser=getUserFromToken(b.token||getToken());
            const username=sessionUser?sessionUser.username:null;

            if(pathname==="/api/start"){
                const hasHuman=room.seats.some((s,i)=>s&&!room.aiTakeover[i]);
                if(!hasHuman)return json(publicRoomState(room,clientId,username));
                if(room.matchOver){resetHand(room);room.team1Score=0;room.team2Score=0;room.handNumber=0;room.matchOver=false;room.matchWinner=null;room.gameLog=[];addRoomLog(room,"🆕 New match started!","system");saveAll();}
                startHand(room);return json(publicRoomState(room,clientId,username));
            }
            if(pathname==="/api/sit"){
                const seatN=parseInt(seat),name=(b.name||"Player").trim();
                const s=room.seats[seatN];
                if(s&&s.clientId!==clientId&&!room.aiTakeover[seatN])return err("Seat taken");
                if(room.conditions.spectatorMode)return err("Room is in spectator mode");
                if(!username&&!room.conditions.allowGuests)return err("This room requires a registered account to play");

                // Min chips check
                const playerChips=getPlayerChips(username,clientId);
                if(room.conditions.minChips&&playerChips<room.conditions.minChips)
                    return err(`This room requires ${room.conditions.minChips} chips to sit. You have ${playerChips}.`);

                // Sit-in cost: 2 chips for everyone
                if(playerChips<CHIPS_SIT_COST)
                    return err(`Sitting costs ${CHIPS_SIT_COST} chips. You only have ${playerChips}.`);
                if(!deductChips(username,clientId,CHIPS_SIT_COST))
                    return err(`Not enough chips to sit (need ${CHIPS_SIT_COST}).`);

                sitPlayer(room,seatN,clientId,name,username);
                return json(publicRoomState(room,clientId,username));
            }
            if(pathname==="/api/stand"){standPlayer(room,clientId);return json(publicRoomState(room,clientId,username));}
            if(pathname==="/api/play"){
                const seatN=parseInt(seat),ci=parseInt(cardIndex);
                if(room.phase==="playing"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.currentTurn===seatN&&!room.awaitingTrickClear&&!room.matchFinished){touchSeat(room,seatN);playCard(room,seatN,ci);runAiLoop(room);}
                return json(publicRoomState(room,clientId,username));
            }
            if(pathname==="/api/bid"){
                const seatN=parseInt(seat);
                if(room.phase==="bidding"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.biddingTurn===seatN&&!room.biddingPassedPlayers.includes(seatN)){touchSeat(room,seatN);processBid(room,seatN,action,value);}
                return json(publicRoomState(room,clientId,username));
            }
            if(pathname==="/api/trump"){
                const seatN=parseInt(seat);
                if(room.phase==="trump"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.highestBidder===seatN){touchSeat(room,seatN);setTrump(room,seatN,suit);}
                return json(publicRoomState(room,clientId,username));
            }
            if(pathname==="/api/reveal-trump"){
                const seatN=parseInt(seat);
                if(room.phase==="playing"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&!room.trumpRevealed&&room.currentTurn===seatN&&!room.awaitingTrickClear){
                    const hand=room.playerHands[seatN];const hasLead=room.leadSuit&&hand.some(c=>c.suit===room.leadSuit);
                    if(!hasLead&&room.leadSuit){room.trumpRevealed=true;addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room,seatN)}`,'system');}
                }
                return json(publicRoomState(room,clientId,username));
            }
        });return;
    }

    res.writeHead(404);res.end("404");
});

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════
function publicUser(u2){
    return {
        username:u2.username,displayName:u2.displayName||u2.username,
        chips:u2.chips||0,wins:u2.wins||0,losses:u2.losses||0,
        handsPlayed:u2.handsPlayed||0,roomsCreated:u2.roomsCreated||0,
        createdAt:u2.createdAt,
    };
}

// ════════════════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════════════════
loadRoomsFromDisk();
["rooms.json","players.json","matches.json","users.json","guests.json"].forEach(f=>{
    const fp=path.join(DATA_DIR,f);
    const fallback = (f==="matches.json") ? [] : {};
    if(!fs.existsSync(fp)) saveJSON(fp, fallback);
});
console.log(`Data files at: ${DATA_DIR}`);
server.listen(PORT,()=>console.log(`29 Card Game server on http://localhost:${PORT}`));
