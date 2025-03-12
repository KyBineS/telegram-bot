const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { Stage, WizardScene } = Scenes;
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();
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
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

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

const broadcastScene = new WizardScene(
    'broadcast',
    async (ctx) => {
        // Для запуска через кнопку используем ctx.reply вместо editMessageText
        if (ctx.updateType === 'callback_query') {
            await ctx.reply('Введите время мероприятия (например: 15:00 25.12.2024):');
        } else {
            await ctx.reply('Введите время мероприятия (например: 15:00 25.12.2024):');
        }
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

    async (ctx) => {
        ctx.wizard.state.link = ctx.message.text;

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
        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.callbackQuery?.data === 'confirm_send') {
            await pool.query(
                'INSERT INTO scheduled_messages (message_text, link, event_time) VALUES ($1, $2, $3)',
                [ctx.wizard.state.message, ctx.wizard.state.link, ctx.wizard.state.time]
            );
            await ctx.editMessageText('✅ Рассылка запланирована!');
        } else {
            await ctx.editMessageText('❌ Рассылка отменена');
        }
        return ctx.scene.leave();
    }
);

// Настройка бота
const stage = new Stage([broadcastScene]);
bot.use(session())
bot.use(stage.middleware());

bot.start(async (ctx) => {
    try {
        await pool.query(
            'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [ctx.from.id]
        );

        logAction('NEW_USER', ctx.from.id);

        await ctx.reply('🎉 Добро пожаловать!', Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Подписаться', 'subscribe'),
                Markup.button.callback('❌ Отписаться', 'unsubscribe_btn')
            ]
        ]));
    } catch (err) {
        console.error('Ошибка регистрации:', err);
    }
});
// Обработчики кнопок для пользователей
bot.action('subscribe', async (ctx) => {
    try {
        await pool.query(
            'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [ctx.from.id]
        );
        await ctx.editMessageText('✅ Вы подписаны на рассылку');
    } catch (err) {
        await ctx.editMessageText('⚠️ Ошибка подписки');
    }
});
bot.action('start_broadcast', async (ctx) => {
    await ctx.answerCbQuery(); // Закрываем "часики" на кнопке
    await ctx.scene.enter('broadcast');
});
bot.action('unsubscribe_btn', async (ctx) => {
    await pool.query('DELETE FROM users WHERE user_id = $1', [ctx.from.id]);
    await ctx.editMessageText('❌ Вы отписались от рассылки');
    logAction('UNSUBSCRIBE', ctx.from.id);
});
// Обновляем админское меню
bot.command('admin', async (ctx) => {
    if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;

    await ctx.reply(
        'Панель управления:',
        Markup.inlineKeyboard([
            [
                Markup.button.callback('📤 Создать рассылку', 'start_broadcast'),
                Markup.button.callback('👥 Список пользователей', 'list_users')
            ],
            [
                Markup.button.callback('🗑 Удалить пользователя', 'remove_user'),
                Markup.button.callback('📊 Статистика', 'stats_btn')
            ]
        ])
    );
});
// Обработчики админских кнопок
bot.action('list_users', async (ctx) => {
    const users = await pool.query('SELECT user_id FROM users');
    const userList = users.rows.map(u => `👤 ID: ${u.user_id}`).join('\n');
    await ctx.editMessageText(`Список подписчиков (${users.rowCount}):\n${userList}`);
});

bot.action('remove_user', async (ctx) => {
    await ctx.editMessageText('Введите ID пользователя для удаления:');
    ctx.session.waitingForUserId = true;
});
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
bot.on('text', async (ctx) => {
    if (ctx.session.waitingForUserId && ctx.from.id.toString() === process.env.ADMIN_ID) {
        const userId = ctx.message.text;
        try {
            await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
            await ctx.reply(`✅ Пользователь ${userId} удалён`);
            logAction('USER_REMOVED', ctx.from.id, `Target: ${userId}`);
        } catch (err) {
            await ctx.reply('❌ Ошибка удаления');
        }
        ctx.session.waitingForUserId = false;
    }
});

bot.action('stats_btn', async (ctx) => {
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const messages = await pool.query('SELECT COUNT(*) FROM scheduled_messages');
    await ctx.editMessageText(`
    📊 Статистика:
    👥 Пользователей: ${users.rows[0].count}
    📨 Активных рассылок: ${messages.rows[0].count}
  `);
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