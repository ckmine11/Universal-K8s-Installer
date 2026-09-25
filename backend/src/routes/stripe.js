import express from 'express'
import Stripe from 'stripe'
import { authService } from '../services/authService.js'
import { requireAuth } from '../middleware/authMiddleware.js'

// Initialize Stripe with a dummy key for now. It will use process.env.STRIPE_SECRET_KEY
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy', {
    apiVersion: '2023-10-16',
})

const router = express.Router()

// Endpoint to create a checkout session — requires authenticated user
router.post('/create-checkout-session', express.json(), requireAuth, async (req, res) => {
    try {
        const { planId } = req.body
        const userId = req.user.id  // Always use the authenticated user's ID

        let priceId = ''
        let planName = ''

        // Map plan IDs to Stripe Price IDs (We use mock IDs for development)
        if (planId === 'pro') {
            priceId = process.env.STRIPE_PRICE_PRO || 'price_mock_pro'
            planName = 'PRO'
        } else if (planId === 'unlimited') {
            priceId = process.env.STRIPE_PRICE_UNLIMITED || 'price_mock_unlimited'
            planName = 'UNLIMITED'
        } else {
            return res.status(400).json({ error: 'Invalid plan selected' })
        }

        // Mock Checkout for Development (Bypasses Stripe if no real key is present)
        if (!process.env.STRIPE_SECRET_KEY) {
            console.log(`[Stripe Mock] Upgrading user ${userId} to ${planName}`)
            
            // Mock Webhook Logic
            const user = authService.getUserById(userId)
            if (user) {
                user.subscription = {
                    plan: planName,
                    maxClusters: planName === 'PRO' ? 5 : 9999,
                    maxNodes: planName === 'PRO' ? 20 : 9999
                }
                authService.saveUsers()
            }
            
            return res.json({ url: '/settings?success=true' })
        }

        // Real Stripe Checkout
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?canceled=true`,
            client_reference_id: userId,
            metadata: {
                planName: planName
            }
        })

        res.json({ url: session.url })
    } catch (error) {
        console.error('Stripe Checkout Error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Webhook endpoint to receive events from Stripe
// Note: We use express.raw({type: 'application/json'}) because Stripe needs raw body for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature']
    let event

    try {
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET is not configured — rejecting webhook.')
            return res.status(500).json({ error: 'Webhook secret not configured on server' })
        }
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`)
        return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object
        const userId = session.client_reference_id
        const planName = session.metadata.planName

        console.log(`[Stripe Webhook] Payment received! Upgrading user ${userId} to ${planName}`)

        const user = authService.getUserById(userId)
        if (user) {
            user.subscription = {
                plan: planName,
                maxClusters: planName === 'PRO' ? 5 : 9999,
                maxNodes: planName === 'PRO' ? 20 : 9999
            }
            authService.saveUsers()
            console.log(`[Stripe Webhook] Successfully upgraded user ${user.username}`)
        } else {
            console.error(`[Stripe Webhook] User ${userId} not found in database.`)
        }
    }

    res.json({ received: true })
})

export default router
