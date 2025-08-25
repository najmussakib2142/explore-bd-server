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
        const storiesCollection = db.collection('stories');



        const verifyFBToken = async (req, res, next) => {
            // console.log('header in middleware', req.headers);
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                console.log("Missing authorization header");
                return res.status(401).send({ message: 'unauthorized access' })
            }
            const token = authHeader.split(" ")[1];
            if (!token) {
                console.log("Missing token");
                return res.status(401).send({ message: 'unauthorized access' })
            }
            // verify the token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                console.error("Token verification failed:", error);
                return res.status(401).send({ message: 'unauthorized access' })
            }
        }
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }


        // -----------------------USERS--------------------

        app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
            const emailQuery = req.query.email;
            if (!emailQuery) {
                return res.status(400).send({ message: "Missing email query" });
            }

            const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

            try {
                const users = await usersCollection
                    .find({ email: { $regex: regex } })
                    // .project({ email: 1, createdAt: 1, role: 1 })
                    .limit(10)
                    .toArray();
                res.send(users);
            } catch (error) {
                console.error("Error searching users", error);
                res.status(500).send({ message: "Error searching users" });
            }
        });

        // GET: Get user role by email
        app.get('/users/:email/role', async (req, res) => {
            try {
                const email = req.params.email;

                if (!email) {
                    return res.status(400).send({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: 'User not found' });
                }


                res.send({ role: user.role || 'user' });
            } catch (error) {
                console.error('Error getting user role:', error);
                res.status(500).send({ message: 'Failed to get role' });
            }
        });


        app.get('/users/:email', async (req, res) => {
            try {
                const { email } = req.params;
                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(404).json({ message: "User not found" });
                res.json(user);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Something went wrong" });
            }
        })

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

        app.patch("/users/:email", async (req, res) => {
            const email = req.params.email;
            const updateData = req.body;

            try {
                const result = await usersCollection.updateOne(
                    { email }, // find user by email
                    { $set: updateData } // update fields
                );

                res.send({
                    success: true,
                    message: "User updated successfully",
                    result,
                });
            } catch (err) {
                res.status(500).send({
                    success: false,
                    message: "Failed to update user",
                    error: err.message,
                });
            }
        });

        app.patch("/users/:id/role", verifyFBToken, async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;

            if (!["admin", "user"].includes(role)) {
                return res.status(400).send({ message: "Invalid role" });
            }

            try {
                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                );
                res.send({ message: `User role updated to ${role}`, result });
            } catch (error) {
                console.error("Error updating user role", error);
                res.status(500).send({ message: "Failed to update user role" });
            }
        });




        // __________________________ packages -_________________________


        // ✅ POST: Add new package
        app.post("/packages", verifyFBToken, async (req, res) => {
            // console.log('headers in add packages', req.headers);
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
        // app.get("/packages", async (req, res) => {
        //     try {
        //         const result = await packagesCollection.find().toArray();
        //         res.send(result);
        //     } catch (error) {
        //         res.status(500).send({ message: error.message });
        //     }
        // });

        // GET all packages with pagination
        app.get("/packages", async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 0;
                const size = parseInt(req.query.size) || 6;

                const count = await packagesCollection.countDocuments();
                const packages = await packagesCollection
                    .find()
                    .skip(page * size)
                    .limit(size)
                    .toArray();

                res.send({ packages, count });
            } catch (error) {
                console.error("Error fetching packages:", error);
                res.status(500).json({ error: "Failed to fetch packages" });
            }
        });


        app.get("/packages/random", async (req, res) => {
            // console.log('headers in add packages', req.headers);

            try {
                const packages = await packagesCollection.aggregate([{ $sample: { size: 3 } }]).toArray();
                res.json(packages);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        app.get("/packages/:id", async (req, res) => {
            // console.log('headers in /packages/:id', req.headers);
            // console.log('headers in add packages', req.headers);

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

        app.get('/packages/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const query = { _id: new ObjectId(id) };
                const parcel = await packagesCollection.findOne(query);

                if (!parcel) {
                    return res.status(404).send({ message: 'Parcel not found' });
                }

                res.send(parcel);
            } catch (error) {
                console.error('Error fetching parcel by ID:', error);
                res.status(500).send({ message: 'Failed to get parcel' });
            }
        })


        // ---------------bookings---------

        // POST: Create a new booking
        app.post("/bookings", async (req, res) => {
            const info = req.body;
            console.log(info);
            try {
                const bookingData = req.body;  // { userId, packageId, date, guests, ... }
                // bookingData.status = "pending";
                // bookingData.created_at = new Date();

                const result = await bookingsCollection.insertOne(bookingData);
                res.status(201).json({ message: "Booking created", insertedId: result.insertedId });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to create booking" });
            }
        });


        // assign guide
        app.get("/bookings", async (req, res) => {
            try {
                console.log("Query received:", req.query);

                const { email, payment_status, status } = req.query;
                const query = {};

                // allow optional filters
                if (email) query.created_by = email;   // NOTE: in your data it's "created_by"
                if (payment_status) query.payment_status = payment_status;
                if (status) query.status = status;

                console.log("MongoDB query:", query);

                const bookings = await bookingsCollection.find(query).toArray();
                res.json(bookings);
            } catch (error) {
                console.error("Error fetching bookings:", error.message);
                res.status(500).json({ error: "Failed to fetch bookings" });
            }
        });
        // backend/index.js or bookings.routes.js
        app.get("/bookings", verifyFBToken, async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).json({ error: "Email is required" });
                }

                const bookings = await bookingsCollection.find({ created_by: email }).toArray();
                res.json(bookings);
            } catch (error) {
                console.error("Error fetching bookings:", error);
                res.status(500).json({ error: "Internal Server Error" });
            }
        });





        // GET booking by bookingId
        app.get("/bookings/:bookingId", async (req, res) => {
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

        // assign guide
        app.patch("/bookings/:id/assign", async (req, res) => {
            try {
                const { id } = req.params;
                const { guideId, guideEmail, guideName } = req.body;

                const result = await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            guideId,
                            guideEmail,
                            guideName,
                            status: "assigned",
                            updated_at: new Date(),
                        },
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Booking not found" });
                }

                res.send({ success: true, message: "Guide assigned successfully" });
            } catch (error) {
                console.error("Error assigning guide:", error);
                res.status(500).send({ message: "Failed to assign guide" });
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
            // console.log('headers 
            // in /guides/approved', req.headers);
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

        // DO NOT USE ANY VERIFICATION HERE
        app.get("/guides/approved", async (req, res) => {
            console.log('headers in /guides/approved', req.headers);
            try {
                const guides = await guidesCollection.find({ status: "active" }).toArray();
                res.json(guides);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch approved guides" });
            }
        });



        // assign guide
        app.get("/guides/available", async (req, res) => {
            const { district } = req.query;

            try {
                const guides = await guidesCollection
                    .find({
                        district,
                        status: { $in: ["approved", "active"] },
                        // work_status: "available",
                    })
                    .toArray();

                res.send(guides);
            } catch (err) {
                res.status(500).send({ message: "Failed to load guides" });
            }
        });



        app.get("/guides/random", async (req, res) => {
            try {
                const guides = await guidesCollection.aggregate([
                    { $match: { status: "active" } },
                    { $sample: { size: 6 } }
                ]).toArray();
                res.json(guides);
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        app.get("/guides/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const guide = await guidesCollection.findOne({ _id: new ObjectId(id) });
                if (!guide) return res.status(404).json({ error: "Guide not found" });
                res.json(guide);
            } catch (err) {
                res.status(500).json({ error: "Server error" });
            }
        });





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
                res.status(500).send({ message: "Failed to update guide status" });
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




        //_-------------- payment----------------



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

        app.get('/payments', verifyFBToken, async (req, res) => {

            console.log('headers in payment', req.headers);

            try {
                const userEmail = req.query.email;

                // decoded email
                console.log('decoded', req.decoded);
                if (req.decoded.email !== userEmail) {
                    return res.status(403).send({ message: 'forbidden access' })
                }

                const query = userEmail ? { email: userEmail } : {};
                const options = { sort: { paid_at: -1 } }
                const payments = await paymentsCollection.find(query, options).toArray()
                res.send(payments)
            } catch (error) {
                console.error('Error fetching payment history:', error);
                res.status(500).send({ message: 'Failed to get payments' });
            }
        })




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




        // ---------------- Stories-----------------

        app.post('/stories', async (req, res) => {
            try {
                const storyData = req.body;

                // Destructure required fields
                const { title, description, images, createdBy } = storyData;

                // Validate required fields
                if (!title || !description || !createdBy || !createdBy.email) {
                    return res.status(400).json({ message: 'Title, description, and createdBy (with email) are required' });
                }

                // Ensure images is an array
                if (!images || !Array.isArray(images) || images.length === 0) {
                    return res.status(400).json({ message: 'At least one image is required' });
                }

                // Add timestamp
                storyData.createdAt = new Date();

                // Insert into MongoDB
                const result = await storiesCollection.insertOne(storyData);

                res.status(201).json({
                    message: 'Story added successfully',
                    insertedId: result.insertedId,
                });
            } catch (err) {
                console.error('Error adding story:', err);
                res.status(500).json({ message: 'Failed to add story' });
            }
        });


        // BE CAREFUL , CHECK TWICH FOR PUT NEW API AROUND THIS
        app.get("/stories/random", async (req, res) => {
            const count = await storiesCollection.countDocuments();
            const randomStories = await storiesCollection.aggregate([
                { $sample: { size: 4 } }
            ]).toArray();
            res.send(randomStories);
        });


        app.get("/stories", async (req, res) => {
            const stories = await storiesCollection.find().sort({ createdAt: -1 }).toArray();
            res.send(stories);
        });




        app.get("/stories/guide/:email", async (req, res) => {
            const { email } = req.params;
            try {
                const stories = await storiesCollection
                    .find({ "createdBy.email": email })
                    .toArray();
                res.json(stories);
            } catch (err) {
                res.status(500).json({ message: "Failed to fetch guide stories" });
            }
        });



        app.patch("/stories/:id/like", async (req, res) => {
            try {
                const { id } = req.params;
                const { userId } = req.body;

                if (!userId) {
                    return res.status(400).json({ message: "Invalid userId" });
                }

                const story = await storiesCollection.findOne({ _id: new ObjectId(id) });
                if (!story) return res.status(404).json({ message: "Story not found" });

                let updatedLikes;

                if (story.likes?.includes(userId)) {
                    // Unlike
                    updatedLikes = story.likes.filter((id) => id !== userId);
                } else {
                    // Like
                    updatedLikes = [...(story.likes || []), userId];
                }

                await storiesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { likes: updatedLikes } }
                );

                res.json({ likes: updatedLikes });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Something went wrong" });
            }
        });




        // app.post('/stories', async (req, res) => {
        //     try {
        //         const storyData = req.body;
        //         // Validate required fields
        //         const { title, content, images, author, role } = storyData;
        //         if (!title || !content || !author) {
        //             return res.status(400).json({ message: 'Title, content and author are required' });
        //         }

        //         // Add createdAt field
        //         storyData.createdAt = new Date();

        //         // Insert into MongoDB
        //         const result = await storiesCollection.insertOne(storyData);

        //         res.status(201).json({
        //             message: 'Story added successfully',
        //             insertedId: result.insertedId,
        //         });
        //     } catch (err) {
        //         console.error('Error adding story:', err);
        //         res.status(500).json({ message: 'Failed to add story' });
        //     }
        // });




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