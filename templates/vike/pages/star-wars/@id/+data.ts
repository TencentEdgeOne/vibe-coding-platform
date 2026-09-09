// https://vike.dev/data

import type { PageContextServer } from "vike/types";
import { useConfig } from "vike-react/useConfig";
import type { MovieDetails } from "../types.js";
import { starWarsMovies } from "../moviesData.js";

export type Data = Awaited<ReturnType<typeof data>>;

export async function data(pageContext: PageContextServer) {
  // https://vike.dev/useConfig
  const config = useConfig();

  let movie = starWarsMovies.find(({ id }) => id === pageContext.routeParams.id);
  if (!movie) throw new Error(`No Star Wars movie with id ${pageContext.routeParams.id}`);

  config({
    // Set <title>
    title: movie.title,
  });

  // We remove data we don't need because the data is passed to
  // the client; we should minimize what is sent over the network.
  movie = minimize(movie);

  return { movie };
}

function minimize(movie: MovieDetails): MovieDetails {
  const { id, title, release_date, director, producer } = movie;
  return { id, title, release_date, director, producer };
}
