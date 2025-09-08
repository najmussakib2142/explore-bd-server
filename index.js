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
app.use(cors({
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json());

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
// const serviceAccount = JSON.parse(decodedKey);

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
        // await client.connect();

        const db = client.db("exploreBD");
        const packagesCollection = db.collection("packages");
        const usersCollection = db.collection('users')
        const guidesCollection = db.collection('guides')
        const bookingsCollection = db.collection('bookings')
        const paymentsCollection = db.collection('payments');
        const storiesCollection = db.collection('stories');

        // ✅ Ensure index on status for faster filtering
        await guidesCollection.createIndex({ status: 1 });

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
        // const verifyAdmin = async (req, res, next) => {
        //     const email = req.decoded.email;
        //     const query = { email }
        //     const user = await usersCollection.findOne(query);
        //     if (!user || user.role !== 'admin') {
        //         return res.status(403).send({ message: 'forbidden access' })
        //     }
        //     next();
        // }

        const verifyRole = (allowedRoles) => {
            return async (req, res, next) => {
                try {
                    const email = req.decoded.email;

                    const user = await usersCollection.findOne({ email });
                    if (!user) {
                        return res.status(404).send({ message: "User not found" });
                    }

                    // Admin bypass: admin can access all routes
                    if (user.role === "admin" || allowedRoles.includes(user.role)) {
                        return next();
                    }

                    return res.status(403).send({ message: "Forbidden access" });
                } catch (error) {
                    console.error("verifyRole error:", error);
                    return res.status(500).send({ message: "Server error" });
                }
            };
        };



        // -----------------------USERS--------------------

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

        // ✅ Get Users with search + filter + pagination // use in admin home
        app.get("/users", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
            try {
                const { email, page = 1, limit = 10, search = "", role = "all" } = req.query;

                // If email query exists, return single user
                if (email) {
                    const user = await usersCollection.findOne({ email });
                    if (!user) return res.status(404).send({ message: "User not found" });
                    return res.send(user);
                }

                // Otherwise, return paginated users
                const pageNum = parseInt(page);
                const limitNum = parseInt(limit);

                const query = {};

                if (search) {
                    query.$or = [
                        { name: { $regex: search, $options: "i" } },
                        { email: { $regex: search, $options: "i" } },
                    ];
                }

                if (role && role !== "all") {
                    query.role = role;

                    // Ignore rejected guides
                    if (role === "guide") {
                        query.status = { $ne: "rejected" }; // status not equal to rejected
                    }
                }

                const skip = Math.max((pageNum - 1) * limitNum, 0);

                const users = await usersCollection
                    .find(query)
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                const total = await usersCollection.countDocuments(query);

                res.json({
                    users,
                    total,
                    page: pageNum,
                    totalPages: Math.ceil(total / limitNum),
                });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch users", error: err.message });
            }
        });


        app.get("/users/search", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
            const emailQuery = req.query.email;
            const page = parseInt(req.query.page) || 0;
            const limit = parseInt(req.query.limit) || 10;

            if (!emailQuery) {
                return res.status(400).send({ message: "Missing email query" });
            }

            const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

            try {
                const filter = { email: { $regex: regex } };

                const users = await usersCollection
                    .find(filter)
                    .skip(page * limit)
                    .limit(limit)
                    .toArray();

                const count = await usersCollection.countDocuments(filter);

                res.send({
                    users,
                    count,
                    page,
                    limit
                });
            } catch (error) {
                console.error("Error searching users", error);
                res.status(500).send({ message: "Error searching users" });
            }
        });


        // GET: Get user role by email
        app.get('/users/:email/role', verifyFBToken, async (req, res) => {
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


        app.get('/users/:email', verifyFBToken, async (req, res) => {
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



        app.patch("/users/:email", async (req, res) => {
            const email = req.params.email;
            const updateData = req.body;

            delete updateData.email;
            delete updateData.role;

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

        app.patch("/users/:id/role", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
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

        // PATCH reject guide status in usersCollection
        app.patch("/users/:email/status", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
            const { email } = req.params;
            const { status } = req.body;

            if (!email || !status) return res.status(400).json({ message: "Email and status are required" });

            try {
                const result = await usersCollection.updateOne({ email }, { $set: { status } });

                if (result.modifiedCount === 0) {
                    return res.status(404).json({ message: "User not found or status unchanged" });
                }

                res.json({ message: "User status updated successfully" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to update user status" });
            }
        });





        // __________________________ packages -_________________________

        // ✅ POST: Add new package
        app.post("/packages", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
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

        // Place this BEFORE /packages/:id
        app.get("/top-booked-packages", async (req, res) => {
            try {
                const result = await bookingsCollection.aggregate([
                    // Only include accepted and paid bookings
                    {
                        $match: {
                            booking_status: "accepted",
                            payment_status: "paid"
                        }
                    },
                    // Convert packageId to ObjectId
                    {
                        $addFields: {
                            packageId: { $toObjectId: "$packageId" }
                        }
                    },
                    // Group by packageId and count
                    {
                        $group: {
                            _id: "$packageId",
                            totalBookings: { $sum: 1 }
                        }
                    },
                    { $sort: { totalBookings: -1 } },
                    { $limit: 4 },
                    // Join with packages collection
                    {
                        $lookup: {
                            from: "packages",
                            localField: "_id",
                            foreignField: "_id",
                            as: "package"
                        }
                    },
                    { $unwind: "$package" },
                    // Select fields to return
                    {
                        $project: {
                            _id: "$package._id",
                            title: "$package.title",
                            image: { $arrayElemAt: ["$package.images", 0] },
                            description: "$package.about",
                            totalDays: "$package.totalDays",
                            price: "$package.price",
                            totalBookings: 1
                        }
                    }
                ]).toArray();

                res.json(result);
            } catch (error) {
                console.error("❌ Error fetching top booked packages:", error);
                res.status(500).json({ error: error.message, stack: error.stack });
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
        app.get("/myBookings", verifyFBToken, async (req, res) => {
            try {
                const { email, page = 0, limit = 10 } = req.query;
                if (!email) {
                    return res.status(400).json({ error: "Email is required" });
                }

                const query = { created_by: email };
                const totalBookings = await bookingsCollection.countDocuments(query);
                const bookings = await bookingsCollection
                    .find(query)
                    .sort({ created_at: -1 })
                    .skip(Number(page) * Number(limit))
                    .limit(Number(limit))
                    .toArray();

                res.json({
                    bookings,
                    totalPages: Math.ceil(totalBookings / limit),
                });
            } catch (error) {
                console.error("Error fetching bookings:", error);
                res.status(500).json({ error: "Internal Server Error" });
            }
        });






        // app.get("/bookings/admin", verifyFBToken, async (req, res) => {
        //     try {
        //         const bookings = await bookingsCollection.find({
        //             payment_status: "paid",
        //             booking_status: "pending",
        //         }).toArray();
        //         res.json(bookings);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Failed to fetch bookings" });
        //     }
        // });



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



        app.patch("/bookings/:id", async (req, res) => {
            const { id } = req.params;
            const { payment_status, payment, booking_status } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ error: "Invalid booking ID" });
            }

            try {
                // const db = getDb();
                const result = await db.collection("bookings").updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            payment_status: payment_status || "paid",
                            booking_status: booking_status || "in-review",
                            payment: {
                                transactionId: payment.transactionId,
                                method: payment.method,
                                paid_at: payment.paid_at || new Date(),
                                amount: payment.amount,
                            },
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ error: "Booking not found" });
                }

                res.json({ success: true, message: "Booking payment updated successfully" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "Internal server error" });
            }
        });

        // 2️⃣ Approve booking (assign guide)

        // app.patch('/bookings/approve/:id', verifyFBToken, async (req, res) => {
        //     try {
        //         const bookingId = req.params.id;
        //         const adminEmail = req.decoded.email;

        //         const result = await bookingsCollection.updateOne(
        //             { _id: new ObjectId(bookingId) }, // ✅ filter object
        //             {
        //                 $set: {
        //                     booking_status: "guide_assigned",
        //                     assignedAt: new Date().toISOString(),
        //                     assignedBy: adminEmail,
        //                 }
        //             }
        //         );

        //         if (result.modifiedCount === 0) {
        //             return res.status(404).send({ message: "Booking not found or already updated" });
        //         }

        //         res.json({ success: true, message: "Booking approved and guide assigned" });
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).send({ message: "Server Error" });
        //     }
        // });

        app.get('/bookings/assigned/:email', verifyFBToken, verifyRole(["guide"]), async (req, res) => {
            try {
                const guideEmail = req.decoded.email;
                const { page = 0, limit = 10 } = req.query; // pagination params

                const query = {
                    guideEmail,
                    booking_status: { $in: ['pending', 'in-review', 'accepted', 'guide_assigned'] }
                };

                const totalBookings = await bookingsCollection.countDocuments(query);

                const assignedTours = await bookingsCollection
                    .find(query)
                    .sort({ created_at: -1 }) // newest first
                    .skip(Number(page) * Number(limit))
                    .limit(Number(limit))
                    .toArray();

                res.json({
                    assignedTours,
                    totalPages: Math.ceil(totalBookings / limit),
                });

            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server Error" });
            }
        });


        app.patch('/bookings/assigned/:id/status', verifyFBToken, verifyRole(["guide"]), async (req, res) => {
            try {
                const guideEmail = req.decoded.email;
                const bookingId = req.params.id;
                const { action } = req.body; // "accept" or "reject"

                if (!['accept', 'reject'].includes(action)) {
                    return res.status(400).send({ message: "Invalid action" });
                }

                const statusMap = {
                    accept: 'accepted',
                    reject: 'rejected'
                };

                const result = await bookingsCollection.updateOne(
                    { _id: new ObjectId(bookingId), guideEmail, booking_status: 'in-review' }, // updated filter
                    {
                        $set: {
                            booking_status: statusMap[action],
                            updated_at: new Date(),
                        }
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Tour not found or not in-review" }); // updated message
                }

                res.send({ success: true, message: `Tour ${statusMap[action]}` });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server Error" });
            }
        });



        // assign guide

        // app.patch("/bookings/:id/assign", async (req, res) => {
        //     try {
        //         const { id } = req.params;
        //         const { guideId, guideEmail, guideName } = req.body;

        //         const result = await bookingsCollection.updateOne(
        //             { _id: new ObjectId(id) },
        //             {
        //                 $set: {
        //                     guideId,
        //                     guideEmail,
        //                     guideName,
        //                     status: "assigned",
        //                     updated_at: new Date(),
        //                 },
        //             }
        //         );

        //         if (result.modifiedCount === 0) {
        //             return res.status(404).send({ message: "Booking not found" });
        //         }

        //         res.send({ success: true, message: "Guide assigned successfully" });
        //     } catch (error) {
        //         console.error("Error assigning guide:", error);
        //         res.status(500).send({ message: "Failed to assign guide" });
        //     }
        // });


        // DELETE: Remove a booking by ID
        app.delete('/bookings/:id', verifyFBToken, async (req, res) => {
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

        // 1
        app.post("/guides", verifyFBToken, verifyRole(["user"]), async (req, res) => {
            try {
                const guideData = req.body;
                const result = await guidesCollection.insertOne(guideData);
                res.status(201).json({ message: "Guide application submitted", insertedId: result.insertedId });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to apply as guide" });
            }
        });

        // 2
        app.get("/guides", async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 0;
                const limit = parseInt(req.query.limit) || 10;

                const skip = page * limit;

                // Build query dynamically
                const query = {};
                if (req.query.status) query.status = req.query.status; // e.g., pending/approved
                if (req.query.role) query.role = req.query.role;       // e.g., guide/admin

                // Count total documents
                const count = await guidesCollection.countDocuments(query);

                // Fetch only required fields (projection for speed)
                const guides = await guidesCollection
                    .find(query, { projection: { name: 1, email: 1, status: 1 } }) // only send what frontend needs
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                res.send({ guides, count });
            } catch (error) {
                console.error("❌ Failed to load guides:", error);
                res.status(500).send({ message: "Failed to load guides" });
            }
        });

        // 3
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

        // 4
        app.get("/guides/pending", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 0;
                const limit = parseInt(req.query.limit) || 10;
                const skip = page * limit;

                const count = await guidesCollection.countDocuments({ status: "pending" });

                const pendingGuides = await guidesCollection
                    .find({ status: "pending" })
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                // 🔥 Normalize data before sending
                const guides = pendingGuides.map(g => ({
                    ...g,
                    age: g.age || null,
                    created_at: g.created_at
                        ? new Date(g.created_at).toISOString() // always string
                        : null,
                }));

                res.send({ guides, count });
            } catch (error) {
                console.error("Failed to load pending guides:", error);
                res.status(500).send({ message: "Failed to load pending guides" });
            }
        });


        // 5
        // DO NOT USE ANY VERIFICATION HERE
        app.get("/guides/approved", async (req, res) => {
            try {
                // Get page and limit from query params (default: page=0, limit=6)
                const page = parseInt(req.query.page) || 0;
                const limit = parseInt(req.query.limit) || 6;
                const skip = page * limit;

                // Count total approved guides
                const count = await guidesCollection.countDocuments({ status: "active" });

                // Fetch only the requested page
                const guides = await guidesCollection
                    .find({ status: "active" })
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                res.json({ guides, count });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch approved guides" });
            }
        });

        // Get all active guides (for dropdowns)
        app.get("/guides/approved/all", async (req, res) => {
            try {
                const guides = await guidesCollection.find({ status: "active" }).toArray();
                res.json({ guides });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch approved guides" });
            }
        });

        // 6
        app.get("/guides/id/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const guide = await guidesCollection.findOne({ _id: new ObjectId(id) });
                if (!guide) return res.status(404).json({ error: "Guide not found" });
                res.json(guide);
            } catch (err) {
                res.status(500).json({ error: "Server error" });
            }
        });



        // assign guide
        // app.get("/guides/available", async (req, res) => {
        //     const { district } = req.query;

        //     try {
        //         const guides = await guidesCollection
        //             .find({
        //                 district,
        //                 status: { $in: ["approved", "active"] },
        //                 // work_status: "available",
        //             })
        //             .toArray();

        //         res.send(guides);
        //     } catch (err) {
        //         res.status(500).send({ message: "Failed to load guides" });
        //     }
        // });




        // 7
        app.get("/guides/:email", async (req, res) => {
            try {
                const email = req.params.email;

                const guide = await guidesCollection.findOne({ email: email });

                if (!guide) {
                    return res.status(404).json({ message: "Guide not found" });
                }

                res.json(guide);
            } catch (error) {
                console.error("Error fetching guide by email:", error);
                res.status(500).json({ message: "Server error" });
            }
        });


        // 8
        app.patch("/guides/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const updateData = req.body;

                // remove undefined / empty fields so they don't overwrite with null
                Object.keys(updateData).forEach((key) => {
                    if (updateData[key] === undefined || updateData[key] === "") {
                        delete updateData[key];
                    }
                });

                const result = await guidesCollection.updateOne(
                    { email: email },
                    { $set: updateData }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Guide not found" });
                }

                res.json({ message: "Guide updated successfully" });
            } catch (error) {
                console.error("Error updating guide:", error);
                res.status(500).json({ message: "Server error" });
            }
        });


        // 9
        app.patch("/guides/:id/status", verifyFBToken, verifyRole(["admin"]), async (req, res) => {
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




        // 10
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



        // GET payments by user email
        app.get("/payments", verifyFBToken, verifyRole(["user"]), async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                // Find bookings where created_by matches email AND has payment info
                const payments = await bookingsCollection
                    .find({ created_by: email, payment_status: "paid" })
                    .project({
                        _id: 0,
                        // packageId: 1,
                        packageName: 1,
                        "payment.amount": 1,
                        "payment.transactionId": 1,
                        created_by: 1,
                        "payment.paid_at": 1,
                    })
                    .sort({ "payment.paid_at": -1 })
                    .toArray();

                // Transform for frontend use
                const formatted = payments.map((p) => ({
                    // packageId: p.packageId,
                    packageName: p.packageName,
                    amount: p.payment?.amount,
                    transactionId: p.payment?.transactionId,
                    email: p.created_by,
                    paid_at_string: p.payment?.paid_at,
                }));

                res.json(formatted);
            } catch (error) {
                console.error("Error fetching payments:", error);
                res.status(500).json({ message: "Internal server error" });
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




        // ---------------- Stories-----------------

        app.post('/stories', verifyFBToken, verifyRole(["user", "guide"]), async (req, res) => {
            try {
                const storyData = req.body;

                const { title, description, images, createdBy } = storyData;

                if (!title || !description || !createdBy || !createdBy.email) {
                    return res.status(400).json({ message: 'Title, description, and createdBy (with email) are required' });
                }

                if (!images || !Array.isArray(images) || images.length === 0) {
                    return res.status(400).json({ message: 'At least one image is required' });
                }

                storyData.createdAt = new Date();

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
            try {
                // Get page and limit from query params, default to page=0, limit=6
                const page = parseInt(req.query.page) || 0;
                const limit = parseInt(req.query.limit) || 9;
                const skip = page * limit;

                // Count total stories
                const count = await storiesCollection.countDocuments();

                // Fetch only the requested page, sorted by newest first
                const stories = await storiesCollection
                    .find()
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                // Return both stories and total count
                res.send({ stories, count });
            } catch (error) {
                console.error("Failed to load stories:", error);
                res.status(500).send({ message: "Failed to load stories" });
            }
        });

        app.get("/stories/:id", async (req, res) => {
            const { id } = req.params;

            try {
                const story = await storiesCollection.findOne({ _id: new ObjectId(id) });

                if (!story) {
                    return res.status(404).json({ message: "Story not found" });
                }

                res.json(story);
            } catch (err) {
                console.error("Error fetching story:", err);
                res.status(500).json({ message: "Server error" });
            }
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


        app.patch("/stories/:id", verifyFBToken, verifyRole(["user", "guide"]), async (req, res) => {
            console.log("✅ Received PATCH request");
            console.log("Headers:", req.headers);
            console.log("Body:", req.body);
            try {
                const { id } = req.params;
                const { title, description, addImages, removeImages } = req.body;

                const updateDoc = {};

                if (title) updateDoc.title = title;
                if (description) updateDoc.description = description;

                // MongoDB operators
                const operators = {};
                if (addImages && addImages.length) operators.$push = { images: { $each: addImages } };
                if (removeImages && removeImages.length) operators.$pull = { images: { $in: removeImages } };

                if (Object.keys(updateDoc).length) operators.$set = updateDoc;

                const result = await storiesCollection.updateOne(
                    { _id: new ObjectId(id), "createdBy.email": req.decoded.email },
                    operators
                );

                if (result.matchedCount === 0) return res.status(404).json({ message: "Story not found or not authorized" });

                res.json({ message: "Story updated" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to update story" });
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

        // PATCH /stories/:id



        // DELETE /stories/:id
        app.delete("/stories/:id", verifyFBToken, verifyRole(["user", "guide"]), async (req, res) => {
            try {
                const { id } = req.params;

                const result = await storiesCollection.deleteOne({
                    _id: new ObjectId(id),
                    "createdBy.email": req.decoded.email, // only guide can delete own story
                });

                if (result.deletedCount === 0) return res.status(404).json({ message: "Story not found or not authorized" });

                res.json({ message: "Story deleted" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to delete story" });
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

        app.get("/stats", async (req, res) => {
            try {
                // 1. Total Payment (sum only paid bookings)
                const payments = await bookingsCollection.aggregate([
                    { $match: { payment_status: "paid" } }, // only paid bookings
                    { $group: { _id: null, total: { $sum: "$payment.amount" } } }
                ]).toArray();
                const totalPayment = payments[0]?.total || 0;

                // 2. Total Tour Guides (from users collection)
                const totalGuides = await usersCollection.countDocuments({ role: "guide" });

                // 3. Total Packages
                const totalPackages = await packagesCollection.countDocuments();

                // 4. Total Clients (users with role "user")
                const totalClients = await usersCollection.countDocuments({ role: "user" });

                // 5. Total Stories
                const totalStories = await storiesCollection.countDocuments();

                // ✅ Send response
                res.json({
                    totalPayment,
                    totalGuides,
                    totalPackages,
                    totalClients,
                    totalStories
                });
            } catch (error) {
                console.error("Error fetching stats:", error);
                res.status(500).json({ message: "Failed to fetch stats" });
            }
        });


        // GET /stats


        app.get("/stats/packages", async (req, res) => {
            try {
                const packages = await packagesCollection.find().toArray();

                const packageStats = await Promise.all(
                    packages.map(async (pkg) => {
                        // Only paid bookings
                        const bookings = await bookingsCollection
                            .find({
                                packageId: pkg._id.toString(),
                                payment_status: "paid" // filter paid bookings
                            })
                            .toArray();

                        const totalRevenue = bookings.reduce(
                            (sum, b) => sum + (b.price?.$numberInt ? parseInt(b.price.$numberInt) : b.price || 0),
                            0
                        );

                        return {
                            name: pkg.title, // use title
                            bookingsCount: bookings.length,
                            totalRevenue,
                        };
                    })
                );

                // Sort by revenue descending
                packageStats.sort((a, b) => b.totalRevenue - a.totalRevenue);

                res.json(packageStats);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Failed to fetch package stats", error: err.message });
            }
        });








        // Send a ping to confirm a successful connection

        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
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