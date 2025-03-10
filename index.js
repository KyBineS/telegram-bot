const { Telegraf, Scenes, session } = require('telegraf')
const { Stage, WizardScene } = Scenes
const express = require('express')
const { Pool } = require('pg')
const axios = require('axios')
require('dotenv').config()

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
    async (ctx) => {
        await ctx.reply('Введите время мероприятия (например: 15:00 25.12.2024):')
        return ctx.wizard.next()
    },
    async (ctx) => {
        ctx.wizard.state.time = ctx.message.text
        await ctx.reply('Введите текст сообщения:')
        return ctx.wizard.next()
    },
    async (ctx) => {
        ctx.wizard.state.message = ctx.message.text
        await ctx.reply('Введите ссылку на Google Meet:')
        return ctx.wizard.next()
    },
    async (ctx) => {
        ctx.wizard.state.link = ctx.message.text

        try {
            await pool.query(
                'INSERT INTO scheduled_messages (message_text, link, event_time) VALUES ($1, $2, $3)',
                [ctx.wizard.state.message, ctx.wizard.state.link, ctx.wizard.state.time]
            )
            await ctx.reply('✅ Рассылка запланирована!')
        } catch (err) {
            console.error('Ошибка:', err)
            await ctx.reply('❌ Произошла ошибка!')
        }
        return ctx.scene.leave()
    }
)

// Настройка бота
const stage = new Scenes.Stage([broadcastScene])
bot.use(session())
bot.use(stage.middleware())

bot.start(async (ctx) => {
    try {
        await pool.query(
            'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [ctx.from.id]
        )
        await ctx.reply('🎉 Добро пожаловать! Вы подписаны на рассылку.')
    } catch (err) {
        console.error('Ошибка регистрации:', err)
    }
})

bot.command('send', async (ctx) => {
    if (ctx.from.id.toString() === process.env.ADMIN_ID) {
        await ctx.scene.enter('broadcast')
    } else {
        await ctx.reply('⛔ Доступ запрещен!')
    }
})

// Автоматическая рассылка
async function sendMessages() {
    try {
        const messages = await pool.query('SELECT * FROM scheduled_messages')

        for (const msg of messages.rows) {
            const users = await pool.query('SELECT user_id FROM users')
            const text = `📅 ${msg.event_time}\n\n${msg.message_text}\n\nСсылка: ${msg.link}`

            for (const user of users.rows) {
                try {
                    await bot.telegram.sendMessage(user.user_id, text)
                } catch (err) {
                    if (err.code === 403) {
                        await pool.query('DELETE FROM users WHERE user_id = $1', [user.user_id])
                    }
                }
            }

            await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [msg.id])
        }
    } catch (err) {
        console.error('Ошибка рассылки:', err)
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