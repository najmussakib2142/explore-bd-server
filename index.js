const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");


dotenv.config();
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());


const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1l01jrg.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("exploreBD");
        const packagesCollection = db.collection("packages");
        const usersCollection = db.collection('users')
        const guidesCollection = db.collection('guides')
        const bookingsCollection = db.collection('bookings')
        const paymentsCollection = db.collection('payments');



        const verifyFBToken = async (req, res, next) => {
            // console.log('header in middleware', req.headers);
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'unauthorized access' })
            }
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({ message: 'unauthorized access' })
            }

            // verify the token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                return res.status(401).send({ message: 'unauthorized access' })
            }


        }




        app.post('/users', async (req, res) => {
            const email = req.body.email;
            const userExists = await usersCollection.findOne({ email })
            if (userExists) {
                // update last_log_in for existing user
                const updateResult = await usersCollection.updateOne(
                    { email },
                    { $set: { last_log_in: new Date().toISOString() } }
                )
                return res.status(200).send({ message: 'Last login updated', inserted: false, updateResult });
            }
            // New user
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })

        // ✅ POST: Add new package
        app.post("/packages", async (req, res) => {
            console.log('headers in add packages', req.headers);
            try {
                const newPackage = req.body;

                // 🔹 Ensure price is a number
                newPackage.price = parseFloat(newPackage.price);

                // 🔹 Images: make sure it's an array
                if (!Array.isArray(newPackage.images)) {
                    newPackage.images = [newPackage.images];
                }

                // 🔹 Tour plan: make sure it's an array of objects
                if (!Array.isArray(newPackage.plan)) {
                    newPackage.plan = [];
                }

                const result = await packagesCollection.insertOne(newPackage);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        // ✅ GET: All packages
        app.get("/packages", async (req, res) => {
            try {
                const result = await packagesCollection.find().toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        app.get("/packages/random", async (req, res) => {
            console.log('headers in add packages', req.headers);

            try {
                const packages = await packagesCollection.aggregate([{ $sample: { size: 3 } }]).toArray();
                res.json(packages);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        app.get("/packages/:id", async (req, res) => {
            console.log('headers in add packages', req.headers);

            try {
                const id = req.params.id;
                const { ObjectId } = require("mongodb");
                const result = await packagesCollection.findOne({ _id: new ObjectId(id) });

                if (!result) {
                    return res.status(404).send({ message: "Package not found" });
                }

                res.send(result);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        // app.get('/packages/:id', async (req, res) => {
        //     try {
        //         const id = req.params.id;

        //         const query = { _id: new ObjectId(id) };
        //         const parcel = await packagesCollection.findOne(query);

        //         if (!parcel) {
        //             return res.status(404).send({ message: 'Parcel not found' });
        //         }

        //         res.send(parcel);
        //     } catch (error) {
        //         console.error('Error fetching parcel by ID:', error);
        //         res.status(500).send({ message: 'Failed to get parcel' });
        //     }
        // })


        // ---------------bookings---------

        // POST: Create a new booking
        app.post("/bookings", async (req, res) => {
            try {
                const bookingData = req.body;  // { userId, packageId, date, guests, ... }
                bookingData.status = "pending";
                bookingData.created_at = new Date();

                const result = await bookingsCollection.insertOne(bookingData);
                res.status(201).json({ message: "Booking created", insertedId: result.insertedId });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to create booking" });
            }
        });

        // GET booking by bookingId
        app.get('/bookings/:bookingId', async (req, res) => {
            try {
                const { bookingId } = req.params;

                // Make sure you import ObjectId from mongodb
                const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) });

                if (!booking) {
                    return res.status(404).send({ message: 'Booking not found' });
                }

                res.send(booking);
            } catch (error) {
                console.error('Error fetching booking:', error);
                res.status(500).send({ message: 'Failed to get booking' });
            }
        });

        // By UID
        app.get("/bookings/user/:userId", async (req, res) => {
            try {
                const { userId } = req.params;
                // const { email: created_by } = req.params;
                // console.log(email);
                const bookings = await bookingsCollection.find({ userId }).toArray();
                // const bookings = await bookingsCollection.find({ created_by }).toArray();
                res.json(bookings);
            } catch (err) {
                res.status(500).json({ message: "Failed to fetch bookings" });
            }
        });

        // DELETE: Remove a booking by ID
        app.delete('/bookings/:id', async (req, res) => {
            try {
                const id = req.params.id;

                // Convert the string ID into MongoDB ObjectId
                const query = { _id: new ObjectId(id) };

                const result = await bookingsCollection.deleteOne(query);

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: 'Booking not found' });
                }

                res.send({ message: 'Booking deleted successfully', result });
            } catch (error) {
                console.error('Error deleting Booking:', error);
                res.status(500).send({ message: 'Failed to delete Booking' });
            }
        });





        // --------------guides--------------


        app.post("/guides", async (req, res) => {
            try {
                const guideData = req.body;
                const result = await guidesCollection.insertOne(guideData);
                res.status(201).json({ message: "Guide application submitted", insertedId: result.insertedId });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to apply as guide" });
            }
        });




        app.get("/guides", async (req, res) => {
            try {
                const guides = await guidesCollection.find({}).toArray();
                res.status(200).json(guides);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch guides" });
            }
        });

        app.get("/guides/pending", async (req, res) => {
            try {
                const pendingGuides = await guidesCollection
                    .find({ status: "pending" })
                    .toArray();

                res.send(pendingGuides);
            } catch (error) {
                console.error("Failed to load pending guides:", error);
                res.status(500).send({ message: "Failed to load pending guides" });
            }
        });
        // GET /guides/approved
        app.patch("/guides/:id/status", verifyFBToken, async (req, res) => {
            const { id } = req.params;
            const { status, email } = req.body;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set:
                {
                    status
                }
            }
            try {
                const result = await guidesCollection.updateOne(query, updateDoc);

                // update user role for accepting rider
                if (status === 'active') {
                    const userQuery = { email }
                    const userUpdateDoc = {
                        $set: {
                            role: 'guide'
                        }
                    }
                    const roleResult = await usersCollection.updateOne(userQuery, userUpdateDoc)
                    console.log(roleResult.modifiedCount);
                }

                res.send(result);
            } catch (err) {
                res.status(500).send({ message: "Failed to update rider status" });
            }
        });


        app.get("/guides/approved", async (req, res) => {
            try {
                const guides = await guidesCollection.find({ status: "active" }).toArray();
                res.json(guides);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch approved guides" });
            }
        });




        // PATCH /guides/approve/:id - approve a guide
        app.patch("/guides/approve/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const { ObjectId } = require("mongodb");

                const result = await guidesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "guide", approvedAt: new Date() } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Guide not found" });
                }

                res.json({ message: "Guide approved successfully" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to approve guide" });
            }
        });


        app.get("/guides/random", async (req, res) => {
            try {
                const guides = await guidesCollection.aggregate([{ $sample: { size: 6 } }]).toArray();
                res.json(guides);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });


        //_-------------- payment----------------

        app.get('/payments', verifyFBToken, async (req, res) => {

            // console.log('headers in payment', req.headers);

            try {
                const userEmail = req.query.email;

                // decoded email
                console.log('decoded', req.decoded);
                if (req.decoded.email !== userEmail) {
                    return res.status(403).send({ message: 'forbidden access' })
                }

                const query = userEmail ? { email: userEmail } : {};
                const options = { sort: { paid_at: -1 } }
                const payments = await bookingsCollection.find(query, options).toArray()
                res.send(payments)
            } catch (error) {
                console.error('Error fetching payment history:', error);
                res.status(500).send({ message: 'Failed to get payments' });
            }
        })


        app.post('/payments', async (req, res) => {
            try {
                const { packageId, bookingId, email, amount, paymentMethod, transactionId } = req.body;

                // 1. Update parcel's payment_status
                const updateResult = await bookingsCollection.updateOne(
                    { _id: new ObjectId(bookingId) },
                    // { packageId: packageId, email: user.email }, 
                    {
                        $set: {
                            payment_status: 'paid'
                        }
                    }
                );

                if (updateResult.modifiedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already paid' });
                }

                // 2. Insert payment record
                const paymentDoc = {
                    packageId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toISOString(),
                    paid_at: new Date(),
                };

                const paymentResult = await paymentsCollection.insertOne(paymentDoc);

                res.status(201).send({
                    message: 'Payment recorded and parcel marked as paid',
                    insertedId: paymentResult.insertedId,
                });

            } catch (error) {
                console.error('Payment processing failed:', error);
                res.status(500).send({ message: 'Failed to record payment' });
            }
        });



        app.post('/create-payment-intent', async (req, res) => {
            const amountInCents = req.body.amountInCents
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents, // Amount in cents
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


// Example route
app.get("/", (req, res) => {
    res.send("ExplorerBD Server is running 🚀");
});

app.listen(port, () => {
    console.log(`ExplorerBD Server running on port ${port}`);
});