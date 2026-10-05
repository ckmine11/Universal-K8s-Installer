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
        // Buying is a workspace decision: admins only, and the plan goes to the
        // workspace owner (who holds the subscription), never to a member account
        if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
            return res.status(403).json({ error: 'Only a workspace admin can change the plan.' })
        }
        const userId = authService.getOrgOwner(req.user.orgId)?.id || req.user.id

        let priceId = ''
        let planName = ''

        // Map plan IDs to Stripe Price IDs (We use mock IDs for development)
        if (planId === 'pro') {
            priceId = process.env.STRIPE_PRICE_PRO || 'price_mock_pro'
            planName = 'PRO'
        } else {
            return res.status(400).json({ error: 'Invalid plan selected' })
        }

        // If Stripe isn't configured, DO NOT silently grant a paid plan.
        if (!process.env.STRIPE_SECRET_KEY) {
            // Billing is genuinely unavailable — never grant PRO for free unless
            // the mock was EXPLICITLY enabled (NODE_ENV alone is not enough: the
            // dev docker-compose runs saas mode with NODE_ENV=development).
            if (process.env.STRIPE_MOCK !== 'true' || process.env.NODE_ENV === 'production') {
                return res.status(503).json({
                    error: 'Billing is not configured yet. Please contact sales@k8scluster.space to upgrade.'
                })
            }

            // Local/dev only: mock the upgrade so the flow can be tested.
            console.log(`[Stripe Mock — STRIPE_MOCK=true] Upgrading user ${userId} to ${planName}`)
            const user = authService.getUserById(userId)
            if (user) {
                const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                user.subscription = { plan: planName, maxClusters: 10, maxNodes: 50, maxMembers: 5, billingCycle: 'monthly', renewsAt }
                authService.saveUsers()
            }
            return res.json({ url: '/settings?success=true', mock: true })
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
            // Prefer the real Stripe billing-period end when available
            let renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            const periodEnd = session.subscription_details?.current_period_end || session.expires_at
            if (periodEnd) renewsAt = new Date(periodEnd * 1000).toISOString()
            user.subscription = {
                plan: planName,
                maxClusters: 10,
                maxNodes: 50,
                maxMembers: 5,
                billingCycle: 'monthly',
                renewsAt,
                // Kept so later subscription events (cancel/expire) can find this user
                stripeCustomerId: session.customer || null,
                stripeSubscriptionId: session.subscription || null
            }
            authService.saveUsers()
            console.log(`[Stripe Webhook] Successfully upgraded user ${user.username}`)
        } else {
            console.error(`[Stripe Webhook] User ${userId} not found in database.`)
        }
    }

    // Subscription ended (cancelled, or unpaid after Stripe's retries) → back to FREE
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object
        const user = authService.users.find(u =>
            (u.subscription?.stripeSubscriptionId && u.subscription.stripeSubscriptionId === subscription.id) ||
            (!u.subscription?.stripeSubscriptionId && subscription.customer &&
                u.subscription?.stripeCustomerId === subscription.customer))
        if (user) {
            console.log(`[Stripe Webhook] Subscription ${subscription.id} ended — downgrading ${user.username} to FREE`)
            user.subscription = { plan: 'FREE', maxClusters: 1, maxNodes: 2, maxMembers: 1 }
            authService.saveUsers()
        } else {
            console.error(`[Stripe Webhook] No user found for ended subscription ${subscription.id}`)
        }
    }

    res.json({ received: true })
})

export default router
