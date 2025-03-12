const { Telegraf, Scenes, session } = require('telegraf')
const { Stage, WizardScene } = Scenes
const express = require('express')
const { Pool } = require('pg')
const axios = require('axios')
require('dotenv').config()
const fs = require('fs');
const path = require('path');

function logAction(action, userId, details = '') {
    const logMessage = `[${new Date().toISOString()}] ${action} | User: ${userId} | ${details}\n`;
    fs.appendFile(path.join(__dirname, 'actions.log'), logMessage, (err) => {
        if (err) console.error('Ошибка записи в лог:', err);
    });
    console.log(logMessage);
}
// Инициализация
const app = express()
const bot = new Telegraf(process.env.BOT_TOKEN)

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
})

// Создание таблиц
async function initDB() {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id BIGINT UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        message_text TEXT,
        link TEXT,
        event_time TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `)
        console.log('✅ База данных готова')
    } catch (err) {
        console.error('❌ Ошибка базы данных:', err)
    }
}

// Сцена рассылки
const broadcastScene = new WizardScene(
    'broadcast',
    // 🟢 Всё выше этого блока остаётся без изменений!
    async (ctx) => {

        await ctx.reply('Введите время мероприятия (например: 15:00 25.12.2024):');
        ctx.wizard.state.time = ctx.message.text;
        return ctx.wizard.next();

    },
    async (ctx) => {
        ctx.wizard.state.time = ctx.message.text;
        await ctx.reply('Введите текст сообщения:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.message = ctx.message.text;
        await ctx.reply('Введите ссылку на Google Meet:');
        return ctx.wizard.next();
    },
    // 🟢 Добавляем новый блок с подтверждением:
    async (ctx) => {
        ctx.wizard.state.link = ctx.message.text;

        // Отправляем сообщение с подтверждением
        await ctx.replyWithHTML(`
      <b>Подтвердите рассылку:</b>\n
      🕒 Время: <code>${ctx.wizard.state.time}</code>\n
      📢 Текст: ${ctx.wizard.state.message}\n
      🔗 Ссылка: ${ctx.wizard.state.link}
    `, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Отправить', callback_data: 'confirm_send' },
                        { text: '❌ Отменить', callback_data: 'cancel_send' }
                    ]
                ]
            }
        });

        return ctx.wizard.next();  // Переходим к последнему шагу
    },

    // 🟢 Добавляем обработчик колбэков
    async (ctx) => {
        if (ctx.updateType === 'callback_query') {
            if (ctx.callbackQuery.data === 'confirm_send') {
                await pool.query(
                    'INSERT INTO scheduled_messages (message_text, link, event_time) VALUES ($1, $2, $3)',
                    [ctx.wizard.state.message, ctx.wizard.state.link, ctx.wizard.state.time]
                );
                await ctx.editMessageText('✅ Рассылка запланирована!');
            } else {
                await ctx.editMessageText('❌ Рассылка отменена');
            }
        }
        return ctx.scene.leave();
    }
);
// Настройка бота
const stage = new Scenes.Stage([broadcastScene])
bot.use(session())
bot.use(stage.middleware())

bot.start(async (ctx) => {
    try {
        await pool.query(
            'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [ctx.from.id]
        );
        logAction('NEW_USER', ctx.from.id);
        await ctx.reply('🎉 Добро пожаловать! Вы подписаны на рассылку.')
    } catch (err) {
        console.error('Ошибка регистрации:', err)
    }
})
bot.command('unsubscribe', async (ctx) => {
    try {
        await pool.query('DELETE FROM users WHERE user_id = $1', [ctx.from.id]);

        // Логирование отписки
        logAction('UNSUBSCRIBE', ctx.from.id); // <-- Вставить здесь

        await ctx.reply('❌ Вы отписались от рассылки');
    } catch (err) {
        console.error('Ошибка отписки:', err);
        await ctx.reply('⚠️ Ошибка! Попробуйте позже');
    }
});
bot.command('send', async (ctx) => {
    if (ctx.from.id.toString() === process.env.ADMIN_ID) {
        await ctx.scene.enter('broadcast')
    } else {
        await ctx.reply('⛔ Доступ запрещен!')
    }
})
bot.command('users', async (ctx) => {
    if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;

    try {
        const users = await pool.query('SELECT user_id FROM users');
        const userList = users.rows.map(u => `👤 ID: ${u.user_id}`).join('\n');
        await ctx.reply(`Список подписчиков (${users.rowCount}):\n${userList}`);
    } catch (err) {
        console.error('Ошибка:', err);
        await ctx.reply('⚠️ Не удалось получить список');
    }
});
bot.command('remove', async (ctx) => {
    if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;

    const userId = ctx.message.text.split(' ')[1];
    if (!userId) {
        return ctx.reply('Используйте: /remove <user_id>');
    }

    try {
        await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
        logAction('USER_REMOVED', ctx.from.id, `Target: ${userId}`);
        await ctx.reply(`✅ Пользователь ${userId} удалён`);
    } catch (err) {
        console.error('Ошибка удаления:', err);
        await ctx.reply('❌ Ошибка удаления');
    }
});

// Автоматическая рассылка
async function sendMessages() {
    try {
        const messages = await pool.query('SELECT * FROM scheduled_messages');

        for (const msg of messages.rows) {
            const users = await pool.query('SELECT user_id FROM users');

            for (const user of users.rows) {
                try {
                    await bot.telegram.sendMessage(user.user_id, `📅 ${msg.event_time}\n${msg.message_text}\n🔗 ${msg.link}`);
                } catch (err) {
                    if (err.code === 403) { // Пользователь заблокировал бота
                        await pool.query('DELETE FROM users WHERE user_id = $1', [user.user_id]);
                        console.log(`Удалён неактивный: ${user.user_id}`);
                    }
                }
            }

            await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [msg.id]);
        }
    } catch (err) {
        console.error('Ошибка рассылки:', err);
    }
}

// Запуск
;(async () => {
    await initDB()

    app.use(bot.webhookCallback('/'))
    bot.telegram.setWebhook(`${process.env.RENDER_URL}/`)

    const PORT = process.env.PORT || 3000
    app.listen(PORT, () => {
        console.log(`🚀 Бот запущен на порту ${PORT}`)
        setInterval(sendMessages, 60000)

        // Пинг для Render.com
        setInterval(() => {
            if (process.env.RENDER_URL) {
                axios.get(process.env.RENDER_URL).catch(() => {})
            }
        }, 300000)
    })
})()