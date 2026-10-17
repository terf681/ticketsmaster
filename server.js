require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Подключение к Supabase (используем service_role ключ для полного доступа)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express(); 
const server = http.createServer(app); 
const io = new Server(server);

// ИСПРАВЛЕНИЕ: Слушаем 0.0.0.0, чтобы контейнер был доступен извне (Suga/Render)
const PORT = Number(process.env.PORT || 3000); 
const HOST = '0.0.0.0'; 

// Логирование
function log(actor, action, details=''){ console.log(`[LOG] ${actor} | ${action} | ${details}`); }

// Аутентификация
function auth(req,res,next){ if(!req.session.userId) return res.status(401).json({error:'Пожалуйста, войдите.'}); next(); }
async function staff(req,res,next){ 
    const { data: user } = await supabase.from('users').select('role').eq('id', req.session.userId).single();
    if(!user || !['staff','admin'].includes(user.role)) return res.status(403).json({error:'Требуется доступ персонала.'}); 
    next(); 
}

const sessionMiddleware=session({secret:process.env.SESSION_SECRET||'CHANGE_THIS_SECRET',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:7*24*60*60*1000}});
app.use(helmet({contentSecurityPolicy:false})); 
app.use(express.json({limit:'200kb'})); 
app.use(sessionMiddleware); 
app.use(express.static('public')); 
io.engine.use(sessionMiddleware);

// Discord бот
const discord = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]}); let discordReady=false;
function discordConfigured(){return Boolean(process.env.DISCORD_BOT_TOKEN&&process.env.DISCORD_GUILD_ID)}
async function guild(){ if(!discordReady||!process.env.DISCORD_GUILD_ID) return null; return discord.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(()=>null); }

async function createDiscordChannel(ticket){
 const g=await guild(); if(!g) return null;
 const everyone=g.roles.everyone; const overwrites=[{id:everyone.id,deny:[PermissionFlagsBits.ViewChannel]}];
 const { data: owner } = await supabase.from('users').select('*').eq('id', ticket.owner_id).single();
 if(owner?.discord_id) overwrites.push({id:owner.discord_id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]});
 if(process.env.DISCORD_STAFF_ROLE_ID) overwrites.push({id:process.env.DISCORD_STAFF_ROLE_ID,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages]});
 try { const ch=await g.channels.create({name:`ticket-${ticket.number}-${ticket.category_id}`.slice(0,90),type:ChannelType.GuildText,parent:process.env.DISCORD_TICKET_CATEGORY_ID||undefined,topic:`Ticket #${ticket.number} | Web user: ${owner?.username||'unknown'} | ID: ${ticket.id}`,permissionOverwrites:overwrites}); 
    await supabase.from('tickets').update({ discord_channel_id: ch.id }).eq('id', ticket.id);
    return ch;
 } catch(e){ console.error('Discord channel create failed:',e.message); return null; }
}

async function sendToDiscord(ticket, message, authorLabel){ if(!ticket.discord_channel_id||!discordReady) return; const ch=await discord.channels.fetch(ticket.discord_channel_id).catch(()=>null); if(ch?.isTextBased()) await ch.send({embeds:[new EmbedBuilder().setAuthor({name:authorLabel.slice(0,256)}).setDescription(message.slice(0,4000)).setColor(0x7965f2).setTimestamp()] }).catch(e=>console.error('Discord send failed:',e.message)); }

// --- API РОУТЫ ---

app.get('/api/me', async (req,res)=>{
    let user = null;
    if (req.session.userId) {
        const { data } = await supabase.from('users').select('*').eq('id', req.session.userId).single();
        user = data;
    }
    res.json({user:user?{id:user.id,username:user.username,role:user.role}:null,discordConfigured:discordConfigured(),discordReady});
});

app.post('/api/register', async (req,res)=>{
    const username = String(req.body.username||'').trim();
    const password = String(req.body.password||'');
    if(username.length<3||username.length>32) return res.status(400).json({error:'Имя 3–32 символа.'});
    if(password.length<10) return res.status(400).json({error:'Пароль не менее 10 символов.'});

    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const role = count === 0 ? 'admin' : 'user';

    const { data: existing } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
    if(existing) return res.status(409).json({error:'Имя уже занято.'});

    const passwordHash = await bcrypt.hash(password, 12);
    const { data: newUser, error } = await supabase.from('users').insert({
        id: require('crypto').randomUUID(),
        username,
        password_hash: passwordHash,
        role: role
    }).select().single();

    if (error) return res.status(500).json({error: error.message});
    
    req.session.userId = newUser.id;
    log(username,'account.registered',`Role: ${role}`);
    res.json({user:{id:newUser.id,username:newUser.username,role:newUser.role}});
});

app.post('/api/login', async (req,res)=>{
    const username = String(req.body.username||'').trim();
    const password = String(req.body.password||'');
    const { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
    if(!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({error:'Неверное имя или пароль.'});
    
    req.session.userId = user.id;
    log(user.username,'account.login');
    res.json({user:{id:user.id,username:user.username,role:user.role}});
});

app.post('/api/logout', auth, (req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

app.get('/api/categories', auth, async (req,res)=>{
    const { data: user } = await supabase.from('users').select('role').eq('id', req.session.userId).single();
    let query = supabase.from('categories').select('*');
    if (!['staff','admin'].includes(user.role)) query = query.eq('enabled', true);
    const { data } = await query;
    res.json({categories: data});
});

app.post('/api/tickets', auth, async (req,res)=>{
    const { data: user } = await supabase.from('users').select('*').eq('id', req.session.userId).single();
    const { data: category } = await supabase.from('categories').select('*').eq('id', req.body.categoryId).eq('enabled', true).single();
    if(!category) return res.status(400).json({error:'Выберите категорию.'});
    
    const ticketId = require('crypto').randomUUID();
    const { data: newTicket, error } = await supabase.from('tickets').insert({
        id: ticketId,
        owner_id: user.id,
        owner_name: user.username,
        category_id: category.id,
        category_name: category.name,
        subject: String(req.body.subject).slice(0,120),
        status: 'open'
    }).select().single();

    if (error) return res.status(500).json({error: error.message});

    await supabase.from('messages').insert({
        id: require('crypto').randomUUID(),
        ticket_id: ticketId,
        author_id: user.id,
        author_name: user.username,
        content: String(req.body.content).slice(0,5000),
        source: 'web'
    });

    const ch = await createDiscordChannel(newTicket);
    if(ch) io.emit('ticket:update',{ticketId:newTicket.id});
    res.status(201).json({ticket:newTicket, discordSynced:Boolean(ch)});
});

app.get('/api/tickets', auth, async (req,res)=>{
    const { data: user } = await supabase.from('users').select('role').eq('id', req.session.userId).single();
    let query = supabase.from('tickets').select('*, messages(*)');
    if (!['staff','admin'].includes(user.role)) query = query.eq('owner_id', user.id);
    const { data } = await query.order('created_at', { ascending: false });
    res.json({tickets: data});
});

app.get('/api/tickets/:id', auth, async (req,res)=>{
    const { data: ticket } = await supabase.from('tickets').select('*, messages(*)').eq('id', req.params.id).single();
    const { data: user } = await supabase.from('users').select('role').eq('id', req.session.userId).single();
    if(!ticket || (ticket.owner_id !== req.session.userId && !['staff','admin'].includes(user.role))) return res.status(404).json({error:'Тикет не найден.'});
    res.json({ticket});
});

app.post('/api/tickets/:id/messages', auth, async (req,res)=>{
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', req.params.id).single();
    const { data: user } = await supabase.from('users').select('*').eq('id', req.session.userId).single();
    if(!ticket || (ticket.owner_id !== user.id && !['staff','admin'].includes(user.role))) return res.status(404).json({error:'Тикет не найден.'});
    if(ticket.status === 'closed') return res.status(400).json({error:'Тикет закрыт.'});
    
    const msgId = require('crypto').randomUUID();
    const { error } = await supabase.from('messages').insert({
        id: msgId,
        ticket_id: ticket.id,
        author_id: user.id,
        author_name: user.username,
        content: String(req.body.content).slice(0,5000),
        source: 'web'
    });
    if (error) return res.status(500).json({error: error.message});
    
    await supabase.from('tickets').update({ updated_at: new Date().toISOString() }).eq('id', ticket.id);
    await sendToDiscord(ticket, req.body.content, `${user.username} (website)`);
    io.emit('ticket:update',{ticketId:ticket.id});
    res.json({ok:true});
});

app.patch('/api/tickets/:id', auth, staff, async (req,res)=>{
    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', req.params.id).single();
    if(!ticket) return res.status(404).json({error:'Тикет не найден.'});
    
    const updates = {};
    if(req.body.status) updates.status = req.body.status;
    updates.updated_at = new Date().toISOString();
    
    const { error } = await supabase.from('tickets').update(updates).eq('id', ticket.id);
    if (error) return res.status(500).json({error: error.message});
    
    if(updates.status === 'closed' && ticket.discord_channel_id && discordReady){
        const ch = await discord.channels.fetch(ticket.discord_channel_id).catch(()=>null);
        if(ch) await ch.send(`Ticket closed by ${req.body.by || 'staff'}.`).catch(()=>{});
    }
    io.emit('ticket:update',{ticketId:ticket.id});
    res.json({ok:true});
});

app.get('/api/admin/users', auth, staff, async (req,res)=>{
    const { data } = await supabase.from('users').select('id, username, role, created_at');
    res.json({users: data});
});

app.patch('/api/admin/users/:id/role', auth, async (req,res)=>{
    const { data: me } = await supabase.from('users').select('role').eq('id', req.session.userId).single();
    if (me.role !== 'admin') return res.status(403).json({error:'Только админ.'});
    const { error } = await supabase.from('users').update({ role: req.body.role }).eq('id', req.params.id);
    if (error) return res.status(500).json({error: error.message});
    res.json({ok:true});
});

app.get('/api/admin/logs', auth, staff, async (req,res)=> res.json({logs: []}));

app.get('*',(req,res)=>res.sendFile(require('path').join(__dirname,'public','index.html')));

// ИСПРАВЛЕНИЕ: Запуск с HOST = 0.0.0.0
server.listen(PORT, HOST, () => {
    console.log(`Сервер запущен: http://${HOST}:${PORT}`);
});

if(discordConfigured()) discord.login(process.env.DISCORD_BOT_TOKEN).catch(e=>console.error('Ошибка Discord:',e.message));
