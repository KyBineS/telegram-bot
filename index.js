const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { Stage, WizardScene } = Scenes;
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const moment = require('moment-timezone');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

moment.tz.setDefault('Europe/Moscow'); // Устанавливаем московское время

// Функция логирования действий
function logAction(action, userId, details = '') {
    const logMessage = `[${new Date().toISOString()}] ${action} | User: ${userId} | ${details}\n`;
    fs.appendFileSync(path.join(__dirname, 'actions.log'), logMessage);
    console.log(logMessage);
}

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Инициализация базы данных
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
                notification_time TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ База данных готова');
    } catch (err) {
        console.error('❌ Ошибка базы данных:', err);
    }
}

// Сцена создания рассылки
const broadcastScene = new WizardScene(
    'broadcast',
    async (ctx) => {
        await ctx.reply('Введите время мероприятия (например: 15:00 25.12.2024):');
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
            try {
                // Парсим время события
                const eventTime = moment.tz(
                    ctx.wizard.state.time,
                    'HH:mm DD.MM.YYYY',
                    'Europe/Moscow'
                );

                if (!eventTime.isValid()) {
                    await ctx.editMessageText('❌ Неверный формат времени!');
                    return ctx.scene.leave();
                }

                // Вычисляем время уведомления (за 30 минут)
                const notificationTime = eventTime.clone().subtract(30, 'minutes');

                // Сохраняем в базу данных
                await pool.query(
                    `INSERT INTO scheduled_messages 
                    (message_text, link, event_time, notification_time) 
                    VALUES ($1, $2, $3, $4)`,
                    [
                        ctx.wizard.state.message,
                        ctx.wizard.state.link,
                        eventTime.format(),
                        notificationTime.format()
                    ]
                );

                await ctx.editMessageText('✅ Рассылка запланирована!');
            } catch (err) {
                console.error('Ошибка сохранения:', err);
                await ctx.editMessageText('❌ Ошибка при сохранении');
            }
        } else {
            await ctx.editMessageText('❌ Рассылка отменена');
        }
        return ctx.scene.leave();
    }
);

// Настройка сцен
const stage = new Stage([broadcastScene]);
bot.use(session());
bot.use(stage.middleware());

// Команда /start
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

// Обработчики кнопок
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

bot.action('unsubscribe_btn', async (ctx) => {
    await pool.query('DELETE FROM users WHERE user_id = $1', [ctx.from.id]);
    await ctx.editMessageText('❌ Вы отписались от рассылки');
    logAction('UNSUBSCRIBE', ctx.from.id);
});

// Админская панель
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

// Обработчики админских команд
bot.action('start_broadcast', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('broadcast');
});

bot.action('list_users', async (ctx) => {
    const users = await pool.query('SELECT user_id FROM users');
    const userList = users.rows.map(u => `👤 ID: ${u.user_id}`).join('\n');
    await ctx.editMessageText(`Список подписчиков (${users.rowCount}):\n${userList}`);
});

bot.action('remove_user', async (ctx) => {
    await ctx.editMessageText('Введите ID пользователя для удаления:');
    ctx.session.waitingForUserId = true;
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

// Обработка текстовых команд
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

// Автоматическая рассылка
async function sendMessages() {
    try {
        const now = moment().tz('Europe/Moscow');
        const messages = await pool.query(
            'SELECT * FROM scheduled_messages WHERE notification_time <= $1',
            [now.format()]
        );

        for (const msg of messages.rows) {
            const users = await pool.query('SELECT user_id FROM users');

            for (const user of users.rows) {
                try {
                    await bot.telegram.sendMessage(
                        user.user_id,
                        `⏰ Напоминание! Через 30 минут:\n${msg.message_text}\n🔗 ${msg.link}`
                    );
                } catch (err) {
                    if (err.code === 403) {
                        await pool.query('DELETE FROM users WHERE user_id = $1', [user.user_id]);
                    }
                }
            }

            await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [msg.id]);
        }
    } catch (err) {
        console.error('Ошибка рассылки:', err);
    }
}

// Запуск приложения
(async () => {
    await initDB();

    app.use(bot.webhookCallback('/'));
    bot.telegram.setWebhook(`${process.env.RENDER_URL}/`);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Бот запущен на порту ${PORT}`);
        setInterval(sendMessages, 60000); // Проверка каждую минуту

        setInterval(() => {
            if (process.env.RENDER_URL) {
                axios.get(process.env.RENDER_URL).catch(() => {});
            }
        }, 300000); // Пинг каждые 5 минут
    });
})();